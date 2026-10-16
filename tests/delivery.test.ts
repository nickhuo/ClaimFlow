import { expect, test } from "bun:test";
import { setup, sample } from "./helpers/conversation.ts";
import { webhookEmail } from "../src/adapters/email/webhook.ts";
import type { DeliveryRecord } from "../src/application/session-ports.ts";

test("unknown send receipts reconcile without resending, even when the user repeats consent", async () => {
  let sends = 0;
  let checks = 0;
  const { service } = await setup(0, {
    email: {
      mode: "external",
      async send() {
        sends++;
        return "unknown";
      },
      async reconcile() {
        checks++;
        return "submitted";
      },
    },
  });
  try {
    const access = service.create();
    await service.turn(access, { requestId: "one", text: sample });
    await service.turn(access, { requestId: "two", text: "That's all" });
    const uncertain = await service.turn(access, {
      requestId: "three",
      text: "Send",
      action: { type: "send", summaryVersion: 1 },
    });
    expect(uncertain.view.delivery?.status).toBe("unknown");
    expect(uncertain.view.status).toBe("active");
    const skipped = await service.turn(access, {
      requestId: "skip-uncertain",
      text: "Skip email",
      action: { type: "skip", summaryVersion: 1 },
    });
    expect(skipped.view.status).toBe("active");
    expect(skipped.view.delivery?.status).toBe("unknown");
    expect(sends).toBe(1);
    await service.turn(access, {
      requestId: "four",
      text: "Send again",
      action: { type: "send", summaryVersion: 1 },
    });
    expect(sends).toBe(1);
    const confirmed = await service.turn(access, {
      requestId: "five",
      text: "Check status",
      action: { type: "check_delivery", summaryVersion: 1 },
    });
    expect(confirmed.view.delivery?.status).toBe("submitted");
    expect(sends).toBe(1);
    expect(checks).toBe(1);
    expect(service.outbox(access)).toHaveLength(1);
  } finally {
    await service.close();
  }
});

test("checking a failed delivery cannot reuse old consent to send again", async () => {
  let sends = 0;
  const { service } = await setup(0, {
    email: {
      mode: "external",
      async send() {
        sends++;
        return sends === 1 ? "failed" : "submitted";
      },
      async reconcile() {
        return "failed";
      },
    },
  });
  try {
    const access = service.create();
    await service.turn(access, { requestId: "one", text: sample });
    await service.turn(access, { requestId: "two", text: "That's all" });
    await service.turn(access, {
      requestId: "send",
      text: "Send summary",
      action: { type: "send", summaryVersion: 1 },
    });
    const checked = await service.turn(access, {
      requestId: "check",
      text: "Check delivery",
      action: { type: "check_delivery", summaryVersion: 1 },
    });
    expect(checked.view.delivery?.status).toBe("failed");
    expect(checked.view.status).toBe("active");
    expect(sends).toBe(1);
    const retried = await service.turn(access, {
      requestId: "retry",
      text: "Retry email",
      action: { type: "send", summaryVersion: 1 },
    });
    expect(retried.view.delivery?.status).toBe("submitted");
    expect(sends).toBe(2);
    expect(service.outbox(access)).toHaveLength(1);
  } finally {
    await service.close();
  }
});

test("cancellation during external delivery preserves its receipt and prevents duplicate side effects", async () => {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let sends = 0;
  const { service } = await setup(0, {
    email: {
      mode: "external",
      async send() {
        sends++;
        entered.resolve();
        await released.promise;
        return "submitted";
      },
      async reconcile(record) {
        return record.status === "submitted" ? "submitted" : "unknown";
      },
    },
  });
  try {
    const access = service.create();
    await service.turn(access, { requestId: "one", text: sample });
    await service.turn(access, { requestId: "two", text: "That's all" });
    const running = service.turn(access, {
      requestId: "send",
      text: "Send",
      action: { type: "send", summaryVersion: 1 },
    });
    await entered.promise;
    await service.cancel(access, "send");
    released.resolve();
    const cancelled = await running;
    expect(cancelled.error).toBe("cancelled");
    expect(service.outbox(access)[0]?.status).toBe("submitted");
    const checked = await service.turn(access, {
      requestId: "check",
      text: "Check delivery",
      action: { type: "check_delivery", summaryVersion: 1 },
    });
    expect(checked.view.delivery?.status).toBe("submitted");
    expect(sends).toBe(1);
  } finally {
    released.resolve();
    await service.close();
  }
});

test("HTTP email gateway uses durable idempotency IDs and ambiguous failures stay unknown", async () => {
  const received: { path: string; method: string; key: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      received.push({
        path: new URL(request.url).pathname,
        method: request.method,
        key: request.headers.get("Idempotency-Key"),
      });
      return Response.json({ status: request.method === "GET" ? "submitted" : "unknown" });
    },
  });
  try {
    const sender = webhookEmail(server.url.href, "test-gateway-token");
    const record: DeliveryRecord = {
      id: "delivery-1",
      sessionId: "session-1",
      subjectId: "P9",
      summaryVersion: 1,
      recipient: "test@example.com",
      body: "Summary",
      status: "pending",
      createdAt: 0,
    };
    expect(await sender.send(record)).toBe("unknown");
    expect(await sender.reconcile(record)).toBe("submitted");
    expect(received).toEqual([
      { path: "/deliveries", method: "POST", key: "delivery-1" },
      { path: "/deliveries/delivery-1", method: "GET", key: null },
    ]);
  } finally {
    await server.stop(true);
  }
});
