import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { runPiSmoke } from "../scripts/pi-smoke.ts";
import { loadFixtureData } from "../src/adapters/fixtures/index.ts";
import { createSession } from "../src/adapters/pi/session-factory.ts";
import { defineBusinessTool, registerBusinessTools, type BusinessTool, type BusinessToolDefinition } from "../src/adapters/pi/tools.ts";
import type { BusinessToolContracts } from "../src/application/tool-contracts.ts";

const directories: string[] = [];
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "pi-session-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("real Pi session runs a fake-provider prompt and business tool to settlement", async () => {
  const result = await runPiSmoke(await workspace());
  expect(result.sdkVersion).toBe("1.3.0");
  expect(result.providerCalls).toBe(2);
  expect(result.toolExecutions).toBe(1);
});

test("session ignores workspace resources/settings and never persists credentials or transcript", async () => {
  const cwd = await workspace();
  await Bun.write(join(cwd, "AGENTS.md"), "WORKSPACE_SECRET_SENTINEL");
  await Bun.write(join(cwd, ".pi/settings.json"), JSON.stringify({ defaultTools: ["read", "bash"] }));
  await Bun.write(join(cwd, ".pi/SYSTEM.md"), "SYSTEM_SECRET_SENTINEL");
  const provider = fauxProvider({ provider: "isolated", models: [{ id: "offline" }] });
  provider.setResponses([fauxAssistantMessage("Isolated.")]);
  const { session } = await createSession({
    cwd, provider: provider.provider, modelId: "offline", apiKey: "isolated-test-token",
    systemPrompt: "Only the explicit insurance prompt.",
  });
  try {
    expect(session.getActiveToolNames()).toEqual([]);
    expect(session.systemPrompt).not.toContain("SECRET_SENTINEL");
    await session.prompt("Hello", { expandPromptTemplates: false });
    expect(session.getLastAssistantText()).toBe("Isolated.");
    expect(JSON.stringify(session.messages)).not.toContain("isolated-test-token");
    expect((await readdir(cwd)).sort()).toEqual([".pi", "AGENTS.md"]);
  } finally {
    await session.abort();
    session.dispose();
  }
});

test("business guard denial prevents execution inside the actual Pi tool loop", async () => {
  const provider = fauxProvider({ provider: "denied", models: [{ id: "offline" }] });
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("read_case", { caseId: "not-authorized" })),
    fauxAssistantMessage("Verification is required."),
  ]);
  let executions = 0;
  const tool = defineBusinessTool({
    name: "read_case", label: "Read case", description: "Requires identity and ownership.",
    authorize: (input) => {
      expect(input.caseId).toBe("not-authorized");
      throw new Error("Identity verification required");
    },
    async execute() {
      executions += 1;
      throw new Error("PROTECTED_SENTINEL");
    },
  });
  const { session } = await createSession({
    cwd: await workspace(), provider: provider.provider, modelId: "offline", apiKey: "offline",
    systemPrompt: "Do not disclose claim data without verification.", tools: [tool],
  });
  try {
    await session.prompt("Tell me the claim.", { expandPromptTemplates: false });
    expect(executions).toBe(0);
    expect(JSON.stringify(session.messages)).not.toContain("PROTECTED_SENTINEL");
    expect(session.messages.some((message) => message.role === "toolResult" && message.isError)).toBe(true);
  } finally {
    await session.abort();
    session.dispose();
  }
});

test("separate Pi conversations do not inherit each other's messages", async () => {
  const cwd = await workspace();
  const firstProvider = fauxProvider({ provider: "customer", models: [{ id: "offline" }] });
  const secondProvider = fauxProvider({ provider: "customer", models: [{ id: "offline" }] });
  firstProvider.setResponses([fauxAssistantMessage("First conversation only.")]);
  secondProvider.setResponses([fauxAssistantMessage("Second conversation only.")]);
  const common = { cwd, modelId: "offline", apiKey: "offline", systemPrompt: "Insurance support." };
  const { session: first } = await createSession({ ...common, provider: firstProvider.provider });
  const { session: second } = await createSession({ ...common, provider: secondProvider.provider });
  try {
    await first.prompt("FIRST_CALLER_SENTINEL", { expandPromptTemplates: false });
    expect(second.messages).toEqual([]);
    await second.prompt("SECOND_CALLER_SENTINEL", { expandPromptTemplates: false });
    expect(JSON.stringify(first.messages)).not.toContain("SECOND_CALLER_SENTINEL");
    expect(JSON.stringify(second.messages)).not.toContain("FIRST_CALLER_SENTINEL");
    expect(first.getLastAssistantText()).toBe("First conversation only.");
    expect(second.getLastAssistantText()).toBe("Second conversation only.");
  } finally {
    await first.abort();
    await second.abort();
    first.dispose();
    second.dispose();
  }
});

test("tool registration rejects coding tools and duplicate business names", () => {
  const tool = defineBusinessTool({
    name: "record_facts", label: "Record", description: "Record facts.",
    authorize: () => {},
    async execute() { return { recorded: true }; },
  });
  // Deliberately exercise untyped JavaScript/configuration inputs at the runtime boundary.
  expect(() => registerBusinessTools([{ ...tool, name: "read" } as unknown as BusinessTool])).toThrow("business tool names");
  expect(() => registerBusinessTools([tool, tool])).toThrow("Duplicate business tool");
  const raw = {
    name: "record_facts", label: "Raw tool", description: "No authorization wrapper.",
    parameters: {}, async execute() { return { content: [], details: {} }; },
  };
  expect(() => registerBusinessTools([raw as unknown as BusinessTool])).toThrow("defineBusinessTool authorization");
  expect(() => registerBusinessTools([{ ...tool, name: "read_case" }])).toThrow("defineBusinessTool authorization");
  expect(() => registerBusinessTools([{ ...tool, execute: raw.execute }])).toThrow("defineBusinessTool authorization");
});

test("schemas cannot be replaced by untyped tool definitions", () => {
  expect(() => defineBusinessTool({
    name: "record_facts", label: "Invalid", description: "Old configuration", parameters: {},
    authorize: () => {}, async execute() { return { recorded: true }; },
  } as unknown as BusinessToolDefinition<"record_facts">)).toThrow("schemas are owned by the contract");
});

test("canonical arguments reject model-supplied context before authorization or execution", async () => {
  const provider = fauxProvider({ provider: "invalid-input", models: [{ id: "offline" }] });
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("record_facts", { turnId: "turn-1", facts: {}, state: "PRIVATE_SENTINEL" })),
    fauxAssistantMessage("Please provide valid caller facts."),
  ]);
  let authorizations = 0;
  let executions = 0;
  const tool = defineBusinessTool({
    name: "record_facts", label: "Record", description: "Record facts",
    authorize: () => { authorizations += 1; },
    async execute() { executions += 1; return { recorded: true }; },
  });
  const { session } = await createSession({
    cwd: await workspace(), provider: provider.provider, modelId: "offline", apiKey: "offline",
    systemPrompt: "Insurance support.", tools: [tool],
  });
  try {
    await session.prompt("Record the turn.", { expandPromptTemplates: false });
    expect(authorizations).toBe(0);
    expect(executions).toBe(0);
    expect(session.messages.some((message) => message.role === "toolResult" && message.isError)).toBe(true);
  } finally {
    await session.abort();
    session.dispose();
  }
});

test.each([
  ["wrong shape", { unrelated: "PRIVATE_OUTPUT_SENTINEL" }],
  ["extra fields", { recorded: true, private: "PRIVATE_OUTPUT_SENTINEL" }],
  ["uncloneable result", () => "PRIVATE_OUTPUT_SENTINEL"],
])("invalid %s cannot enter the Pi transcript", async (_name, invalid) => {
  const provider = fauxProvider({ provider: "invalid-output", models: [{ id: "offline" }] });
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("record_facts", { turnId: "turn-1", facts: {} })),
    fauxAssistantMessage("The operation could not be confirmed."),
  ]);
  const steps: string[] = [];
  const tool = defineBusinessTool({
    name: "record_facts", label: "Record", description: "Record facts",
    authorize: () => { steps.push("authorize"); },
    async execute() {
      steps.push("execute");
      // Simulate an untyped implementation; TypeScript definitions reject this separately.
      return invalid as BusinessToolContracts["record_facts"]["output"];
    },
  });
  const { session } = await createSession({
    cwd: await workspace(), provider: provider.provider, modelId: "offline", apiKey: "offline",
    systemPrompt: "Insurance support.", tools: [tool],
  });
  try {
    await session.prompt("Record the turn.", { expandPromptTemplates: false });
    expect(steps).toEqual(["authorize", "execute"]);
    const errors = session.messages.filter((message) => message.role === "toolResult" && message.isError);
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors)).toContain("Invalid record_facts output");
    expect(JSON.stringify(session.messages)).not.toContain("PRIVATE_OUTPUT_SENTINEL");
  } finally {
    await session.abort();
    session.dispose();
  }
});

test("a sourced fixture case passes the business contract through the real Pi adapter", async () => {
  const data = await loadFixtureData({ clock: { now: () => Date.parse("2026-10-15T12:00:00.000Z") } });
  const provider = fauxProvider({ provider: "case-fact", models: [{ id: "offline" }] });
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("read_case", { caseId: "CL-2048" })),
    fauxAssistantMessage("The appeal date in the record is in the past."),
  ]);
  const tool = defineBusinessTool({
    name: "read_case", label: "Case", description: "Read the fixed test subject's case",
    authorize: async ({ caseId }) => {
      if (!await data.getCase("P9", caseId)) throw new Error("Case unavailable");
    },
    async execute({ caseId }) {
      const caseFact = await data.getCase("P9", caseId);
      if (!caseFact) throw new Error("Case unavailable");
      return { ...caseFact, origin: "tool", toolName: "read_case", operationId: "case-operation" };
    },
  });
  const { session } = await createSession({
    cwd: await workspace(), provider: provider.provider, modelId: "offline", apiKey: "offline",
    systemPrompt: "Insurance support test with a fixed authorized subject.", tools: [tool],
  });
  try {
    await session.prompt("Read the selected case.", { expandPromptTemplates: false });
    const results = session.messages.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(false);
    expect(JSON.stringify(results)).toContain('"net_pay":"0.00"');
    expect(JSON.stringify(results)).toContain('"appealDeadlineStatus":"past"');
    expect(JSON.stringify(results)).toContain('"resource":"claims.json"');
  } finally {
    await session.abort();
    session.dispose();
  }
});

test("explicit credentials are required, even if the provider could discover credentials", async () => {
  const provider = fauxProvider({ provider: "explicit", models: [{ id: "offline" }] });
  await expect(createSession({
    cwd: await workspace(), provider: provider.provider, modelId: "offline", apiKey: " ", systemPrompt: "Insurance only.",
  })).rejects.toThrow("explicit provider API key");
});
