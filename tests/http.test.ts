import { expect, test } from "bun:test";
import { createHttpHandler } from "../src/adapters/http/handler.ts";
import { sample, setup } from "./helpers/conversation.ts";
import type { SessionAccess } from "../src/application/session-ports.ts";

test("HTTP ownership, strict inputs, safe SSE, replay, reset and outbox enforce the same boundaries", async () => {
  const { service } = await setup();
  const handle = createHttpHandler(service, { mode: "demo", email: "mock" });
  const call = (
    path: string,
    method = "GET",
    data?: unknown,
    access?: SessionAccess,
    extra?: Record<string, string>,
  ) =>
    handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(access ? { Authorization: `Bearer ${access.token}` } : {}),
          ...extra,
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
    );
  try {
    expect((await call("/health")).status).toBe(200);
    expect(
      (await call("/api/sessions", "POST", {}, undefined, { Origin: "https://untrusted.example" }))
        .status,
    ).toBe(403);
    expect((await call("/api/sessions", "POST", { verified: true })).status).toBe(400);
    const a = await (await call("/api/sessions", "POST", {})).json();
    const b = await (await call("/api/sessions", "POST", {})).json();
    const path = `/api/sessions/${a.sessionId}`;
    expect((await call(path, "GET", undefined, b)).status).toBe(404);
    expect((await call(path, "GET")).status).toBe(404);
    expect((await call(`${path}/outbox`, "GET", undefined, a)).status).toBe(400);
    expect(
      (
        await call(
          `${path}/turns`,
          "POST",
          { requestId: "forged", text: "hello", phase: "PROCESS_CASE", verified: true },
          a,
        )
      ).status,
    ).toBe(400);
    const input = { requestId: "first", text: sample };
    const response = await call(`${path}/turns`, "POST", input, a);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const stream = await response.text();
    expect(stream).toContain('"phase":"PROCESS_CASE"');
    expect(stream).toContain("CL-2048");
    for (const secret of [
      "4472",
      "1985-03-15",
      "demo-placeholder",
      "thinking",
      "toolResult",
      a.token,
    ])
      expect(stream).not.toContain(secret);
    const replay = await (await call(`${path}/turns`, "POST", input, a)).text();
    expect(replay).toBe(stream.slice(stream.lastIndexOf("event: result")));
    expect((await call(`${path}/turns`, "POST", { ...input, text: "changed" }, a)).status).toBe(
      200,
    );
    const fresh = await (await call(`${path}/reset`, "POST", {}, a)).json();
    expect(fresh.token).not.toBe(a.token);
    expect(fresh.view.verified).toBe(false);
    expect((await call(path, "GET", undefined, a)).status).toBe(410);
    expect((await call(`/api/sessions/${b.sessionId}`, "GET", undefined, b)).status).toBe(200);
  } finally {
    await service.close();
  }
});

test("disconnecting SSE does not repeat a business request when reconnecting with its requestId", async () => {
  const { service } = await setup();
  const handle = createHttpHandler(service, { mode: "demo", email: "mock" });
  try {
    const access = await service.create();
    const request = () =>
      new Request(`http://localhost/api/sessions/${access.sessionId}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.token}` },
        body: JSON.stringify({ requestId: "lost-transport", text: sample }),
      });
    const first = await handle(request());
    await first.body!.cancel();
    const replay = await handle(request());
    const text = await replay.text();
    expect(text).toContain("CL-2048");
    expect(
      (await service.dependencies.store.read(access, service.dependencies.clock.now())).state
        .identityAudit,
    ).toHaveLength(1);
  } finally {
    await service.close();
  }
});
