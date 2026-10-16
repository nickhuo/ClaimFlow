import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createSession } from "../src/adapters/pi/session-factory.ts";
import { defineBusinessTool } from "../src/adapters/pi/tools.ts";

/** Exercises the installed SDK and its real tool loop without network or credentials. */
export async function runPiSmoke(cwd = process.cwd()) {
  const provider = fauxProvider({
    provider: "pi-smoke",
    models: [{ id: "offline", contextWindow: 16_384, maxTokens: 1_024 }],
  });
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("record_facts", { turnId: "smoke", facts: {} })),
    fauxAssistantMessage("Pi SDK smoke passed."),
  ]);
  let authorizations = 0;
  let toolExecutions = 0;
  const tool = defineBusinessTool({
    name: "record_facts",
    label: "Record caller facts",
    description: "Record this smoke's empty caller facts; returns no protected data.",
    parameters: Type.Object({ turnId: Type.String(), facts: Type.Object({}) }),
    authorize: () => { authorizations += 1; },
    async execute(_id, input) {
      assert.equal(input.turnId, "smoke");
      toolExecutions += 1;
      return { content: [{ type: "text", text: "Empty facts recorded." }], details: { recorded: true } };
    },
  });
  const { session } = await createSession({
    cwd,
    provider: provider.provider,
    modelId: "offline",
    apiKey: "offline-smoke-placeholder",
    systemPrompt: "You are an offline agent harness smoke. Record empty facts, then confirm completion.",
    tools: [tool],
  });
  const events: string[] = [];
  const unsubscribe = session.subscribe((event) => { events.push(event.type); });
  try {
    assert.deepEqual(session.getActiveToolNames(), ["record_facts"]);
    await session.prompt("Record the smoke turn.", { expandPromptTemplates: false });
    assert.equal(session.getLastAssistantText(), "Pi SDK smoke passed.");
    assert.equal(authorizations, 1);
    assert.equal(toolExecutions, 1);
    assert.equal(provider.state.callCount, 2);
    for (const event of ["agent_start", "tool_execution_start", "tool_execution_end", "agent_settled"]) {
      assert.ok(events.includes(event), `Missing SDK event: ${event}`);
    }
    return { sdkVersion: VERSION, providerCalls: provider.state.callCount, toolExecutions, events: [...new Set(events)] };
  } finally {
    unsubscribe();
    await session.abort();
    session.dispose();
  }
}

if (import.meta.main) {
  console.log(JSON.stringify({ status: "passed", ...await runPiSmoke() }, null, 2));
}
