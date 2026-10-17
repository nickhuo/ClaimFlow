import { expect, test } from "bun:test";
import { PostgresSessionStore } from "../src/adapters/postgres/store.ts";
import { initialConversation } from "../src/domain/conversation.ts";
import type { PublicEvent } from "../src/application/session-ports.ts";
import { setup, sample } from "./helpers/conversation.ts";

const database = process.env.TEST_DATABASE_URL;
const integration = test.skipIf(!database);
const open = () => PostgresSessionStore.open(database!);
const clock = { now: Date.now };

integration(
  "Postgres shares sessions across instances and atomically rejects stale versions",
  async () => {
    const first = await open();
    const second = await open();
    const now = Date.now();
    try {
      const a = await first.create(initialConversation(), now, 600_000);
      const b = await second.create(initialConversation(), now, 600_000);
      await expect(second.read({ ...a.access, token: b.access.token }, now)).rejects.toThrow(
        "session_not_found",
      );
      const writes = await Promise.allSettled([
        first.save(a.access, 0, { ...a.record.state, consecutiveOffTopic: 1 }, now, 600_000),
        second.save(a.access, 0, { ...a.record.state, consecutiveOffTopic: 2 }, now, 600_000),
      ]);
      expect(writes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      expect((await second.read(a.access, now)).version).toBe(1);
      expect((await second.read(b.access, now)).state.consecutiveOffTopic).toBe(0);
      await first.revoke(a.access, now);
      await expect(second.read(a.access, now)).rejects.toThrow("session_expired");
      await expect(second.read(b.access, now + 600_000)).rejects.toThrow("session_expired");
    } finally {
      await first.close();
      await second.close();
    }
  },
  45_000,
);

integration(
  "Postgres serializes turns across instances and persists replay and cancellation",
  async () => {
    const first = await open();
    const second = await open();
    const now = Date.now();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      const { access } = await first.create(initialConversation(), now, 600_000);
      const held = first.withSessionLock(access, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      await expect(second.withSessionLock(access, async () => {})).rejects.toThrow(
        "request_in_progress",
      );
      release.resolve();
      await held;
      const input = { requestId: "same-request", text: "Hello" };
      expect(await first.beginRequest(access, input, now)).toBeNull();
      await expect(second.beginRequest(access, input, now)).rejects.toThrow("request_in_progress");
      await expect(
        second.beginRequest(access, { ...input, text: "Different" }, now),
      ).rejects.toThrow("request_id_conflict");
      const { service } = await setup(0, { store: second, clock });
      const result = {
        requestId: input.requestId,
        reply: "Hello",
        error: null,
        view: await service.view(access),
      };
      await first.finishRequest(access, result, now);
      expect(await second.beginRequest(access, input, now)).toEqual(result);
      await second.cancelRequest(access, "cancelled-request", now);
      expect(await first.isRequestCancelled(access, "cancelled-request")).toBe(true);
      expect(await first.isRequestCancelled(access, "another-request")).toBe(false);
    } finally {
      release.resolve();
      await first.close();
      await second.close();
    }
  },
  45_000,
);

integration(
  "Postgres preserves verified conversations and one delivery through cold starts",
  async () => {
    const first = await setup(0, { store: await open(), clock });
    const access = await first.service.create();
    try {
      const verified = await first.service.turn(access, { requestId: "verify", text: sample });
      expect(verified.error).toBeNull();
      expect(verified.view.verified).toBe(true);
    } finally {
      await first.service.close();
    }
    const second = await setup(0, { store: await open(), clock });
    const send = {
      requestId: "send",
      text: "Save summary",
      action: { type: "send" as const, summaryVersion: 1 },
    };
    try {
      expect((await second.service.view(access)).verified).toBe(true);
      const summary = await second.service.turn(access, {
        requestId: "finish",
        text: "That's all",
      });
      expect(summary.view.phase).toBe("POST_PROCESS");
      const sent = await second.service.turn(access, send);
      expect(sent.error).toBeNull();
      expect(sent.view.delivery?.status).toBe("mock_recorded");
    } finally {
      await second.service.close();
    }
    const third = await setup(0, { store: await open(), clock });
    try {
      const replay = await third.service.turn(access, send);
      expect(replay.view.delivery?.status).toBe("mock_recorded");
      expect(await third.service.outbox(access)).toHaveLength(1);
      const fresh = await third.service.reset(access);
      expect((await third.service.view(fresh)).verified).toBe(false);
      await expect(third.service.view(access)).rejects.toThrow("session_expired");
    } finally {
      await third.service.close();
    }
  },
  90_000,
);

for (const action of ["cancel", "reset"] as const) {
  integration(
    `Postgres ${action} from another instance suppresses a late model reply`,
    async () => {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const first = await setup(0, {
        store: await open(),
        clock,
        replyComposer: {
          async compose() {
            started.resolve();
            await release.promise;
            return "LATE_REMOTE_REPLY";
          },
        },
      });
      const second = await setup(0, { store: await open(), clock });
      const events: PublicEvent[] = [];
      try {
        const access = await first.service.create();
        const response = first.service
          .turn(access, { requestId: action, text: sample }, (event) => events.push(event))
          .catch((error: unknown) => error);
        await started.promise;
        if (action === "cancel") await second.service.cancel(access, action);
        else await second.service.reset(access);
        release.resolve();
        const result = await response;
        if (action === "cancel") {
          expect(result).toHaveProperty("error", "cancelled");
          expect((await second.service.view(access)).verified).toBe(true);
        } else {
          expect(result).toBeInstanceOf(Error);
          expect(events.some((event) => event.type === "result")).toBe(false);
        }
        expect(JSON.stringify(events)).not.toContain("LATE_REMOTE_REPLY");
      } finally {
        release.resolve();
        await first.service.close();
        await second.service.close();
      }
    },
    90_000,
  );
}
