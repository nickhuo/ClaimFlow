import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { runPiSmoke } from "../scripts/pi-smoke.ts";
import { createSession } from "../src/adapters/pi/session-factory.ts";
import { defineBusinessTool, registerBusinessTools, type BusinessTool } from "../src/adapters/pi/tools.ts";

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
    parameters: Type.Object({ caseId: Type.String() }),
    authorize: (input) => {
      expect(input.caseId).toBe("not-authorized");
      throw new Error("Identity verification required");
    },
    async execute() {
      executions += 1;
      return { content: [{ type: "text", text: "PROTECTED_SENTINEL" }], details: {} };
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
    parameters: Type.Object({}), authorize: () => {},
    async execute() { return { content: [], details: {} }; },
  });
  // Deliberately exercise untyped JavaScript/configuration inputs at the runtime boundary.
  expect(() => registerBusinessTools([{ ...tool, name: "read" } as unknown as BusinessTool])).toThrow("business tool names");
  expect(() => registerBusinessTools([tool, tool])).toThrow("Duplicate business tool");
  const raw = {
    name: "record_facts", label: "Raw tool", description: "No authorization wrapper.",
    parameters: Type.Object({}), async execute() { return { content: [], details: {} }; },
  };
  expect(() => registerBusinessTools([raw as unknown as BusinessTool])).toThrow("defineBusinessTool authorization");
});

test("explicit credentials are required, even if the provider could discover credentials", async () => {
  const provider = fauxProvider({ provider: "explicit", models: [{ id: "offline" }] });
  await expect(createSession({
    cwd: await workspace(), provider: provider.provider, modelId: "offline", apiKey: " ", systemPrompt: "Insurance only.",
  })).rejects.toThrow("explicit provider API key");
});
