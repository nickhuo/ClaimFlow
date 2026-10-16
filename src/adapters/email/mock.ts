import type { EmailSender } from "../../application/session-ports.ts";

/** The durable outbox lives in the session store; this adapter never sends a real email. */
export function mockEmail(failures = 0): EmailSender {
  const attempts = new Map<string, number>();
  return {
    mode: "mock",
    async send(record, signal) {
      signal?.throwIfAborted();
      const attempt = attempts.get(record.id) ?? 0;
      attempts.set(record.id, attempt + 1);
      if (attempt < failures) return "failed";
      return "mock_recorded";
    },
    async reconcile(record) {
      return record.status === "mock_recorded" ? "mock_recorded" : "unknown";
    },
  };
}
