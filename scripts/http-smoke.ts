import { createParser } from "eventsource-parser";
import type { PublicEvent, SessionAccess, TurnResult } from "../src/application/session-ports.ts";
const base = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function main() {
  const health = await fetch(`${base}/health`);
  assert(health.ok, "Health check failed");
  const created = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert(created.status === 201, "Session creation failed");
  const session = (await created.json()) as SessionAccess;
  const phases: string[] = [];
  async function turn(text: string) {
    const response = await fetch(`${base}/api/sessions/${session.sessionId}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ requestId: crypto.randomUUID(), text }),
    });
    assert(response.ok, "Turn request failed");
    let result: TurnResult | undefined;
    createParser({
      onEvent(event) {
        const value = JSON.parse(event.data) as PublicEvent;
        if (value.type === "result") result = value.result;
        if (value.type === "progress" && phases.at(-1) !== value.phase) phases.push(value.phase);
      },
    }).feed(await response.text());
    assert(result && !result.error, "Turn did not complete successfully");
    return result;
  }
  const answer = await turn(
    "My name is Margaret Chen, policy POL-9921, DOB 1985-03-15, SSN last four 4472. Why was my January healthcare claim denied?",
  );
  assert(
    answer.view.phase === "PROCESS_CASE" &&
      answer.view.verified &&
      answer.reply.includes("CL-2048"),
    "Verified case answer missing",
  );
  const summary = await turn("That's all");
  assert(summary.view.phase === "POST_PROCESS" && summary.view.summary, "Summary missing");
  const skipped = await turn("Skip email");
  assert(skipped.view.status === "completed", "Skip did not finish conversation");
  console.log(
    JSON.stringify({ status: "passed", mode: (await health.json()).mode, phases, completed: true }),
  );
}
if (import.meta.main) await main();
