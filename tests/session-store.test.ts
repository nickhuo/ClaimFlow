import { expect, test } from "bun:test";
import { SqliteSessionStore } from "../src/adapters/sqlite/store.ts";
import { initialConversation } from "../src/domain/conversation.ts";

test("session credentials, expiry and optimistic versions isolate persisted authority", () => {
  const store = new SqliteSessionStore();
  try {
    const a = store.create(initialConversation(), 100, 1000);
    const b = store.create(initialConversation(), 100, 1000);
    expect(() => store.read({ sessionId: a.access.sessionId, token: b.access.token }, 101)).toThrow(
      "session_not_found",
    );
    const next = store.save(a.access, 0, { ...a.record.state, consecutiveOffTopic: 1 }, 102, 1000);
    expect(next.version).toBe(1);
    expect(store.read(b.access, 102).state.consecutiveOffTopic).toBe(0);
    expect(() => store.save(a.access, 0, a.record.state, 103, 1000)).toThrow("version_conflict");
    expect(() => store.read(a.access, 1102)).toThrow("session_expired");
    store.revoke(b.access, 103);
    expect(() => store.read(b.access, 104)).toThrow("session_expired");
  } finally {
    store.close();
  }
});

test("request identifiers are bound to their input and completed requests replay exactly", () => {
  const store = new SqliteSessionStore();
  try {
    const { access } = store.create(initialConversation(), 0, 1000);
    const input = { requestId: "r1", text: "Hello" };
    expect(store.beginRequest(access, input, 1)).toBeNull();
    expect(() => store.beginRequest(access, input, 2)).toThrow("request_in_progress");
    expect(() => store.beginRequest(access, { ...input, text: "Different" }, 2)).toThrow(
      "request_id_conflict",
    );
    const result = {
      requestId: "r1",
      reply: "Hello",
      error: null,
      view: {
        sessionId: access.sessionId,
        version: 0,
        phase: "VERIFY_ID" as const,
        status: "active" as const,
        verified: false,
        authorization: "not_required" as const,
        summary: null,
        delivery: null,
        handoff: null,
      },
    };
    store.finishRequest(access, result, 3);
    expect(store.beginRequest(access, input, 4)).toEqual(result);
  } finally {
    store.close();
  }
});

test("process restart revokes persisted identity and recovers pending receipts as unknown", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Database } = await import("bun:sqlite");
  const directory = await mkdtemp(join(tmpdir(), "business-restart-"));
  const path = join(directory, "sessions.sqlite");
  try {
    const first = new SqliteSessionStore(path);
    const { access } = first.create(initialConversation(), 1, 1000);
    const db = new Database(path);
    db.query("INSERT INTO deliveries VALUES (?,?,?,?,?,?,?,?)").run(
      "delivery",
      access.sessionId,
      "P9",
      1,
      "test@example.com",
      "Summary",
      "pending",
      1,
    );
    db.close();
    first.close();
    const restarted = new SqliteSessionStore(path);
    try {
      expect(() => restarted.read(access, 2)).toThrow("session_expired");
      const fresh = restarted.create(initialConversation(), 2, 1000);
      expect(fresh.record.state.identity.status).toBe("unverified");
      expect(restarted.deliveries(fresh.access, 3)).toHaveLength(0);
      const inspect = new Database(path, { readonly: true });
      expect(
        inspect.query<{ status: string }, []>("SELECT status FROM deliveries").get()?.status,
      ).toBe("unknown");
      inspect.close();
    } finally {
      restarted.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
