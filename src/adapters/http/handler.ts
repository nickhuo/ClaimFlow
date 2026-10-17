import { Type } from "typebox";
import { Check } from "typebox/value";
import { RuleViolation } from "../../domain/conversation.ts";
import type { ConversationService } from "../../application/sessions.ts";
import type { PublicEvent, SessionAccess, TurnInput } from "../../application/session-ports.ts";

const requestId = Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-zA-Z0-9_-]+$" });
const empty = Type.Object({}, { additionalProperties: false });
const action = Type.Union([
  Type.Object(
    { type: Type.Enum(["finish", "handoff", "resume"]) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Enum(["send", "skip", "check_delivery"]),
      summaryVersion: Type.Integer({ minimum: 1 }),
      recipient: Type.Optional(Type.String({ minLength: 3, maxLength: 254 })),
    },
    { additionalProperties: false },
  ),
]);
const turn = Type.Object(
  {
    requestId,
    text: Type.String({ minLength: 1, maxLength: 6000 }),
    action: Type.Optional(action),
  },
  { additionalProperties: false },
);
const cancel = Type.Object({ requestId }, { additionalProperties: false });
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const publicCodes = new Set([
  "session_not_found",
  "session_expired",
  "request_id_conflict",
  "request_in_progress",
  "stale_request",
  "version_conflict",
  "verification_required",
  "authorization_required",
  "handoff_requested",
  "invalid_request",
  "origin_not_allowed",
  "service_unavailable",
]);
const safeCode = (error: unknown) =>
  error instanceof RuleViolation && publicCodes.has(error.code)
    ? error.code
    : "service_unavailable";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });

async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    throw new RuleViolation("invalid_request");
  if (!request.body) throw new RuleViolation("invalid_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 24_000) {
        await reader.cancel();
        throw new RuleViolation("invalid_request");
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    throw new RuleViolation("invalid_request");
  } finally {
    reader.releaseLock();
  }
}

export interface HttpConfiguration {
  readonly mode: "demo" | "live";
  readonly email: "mock" | "external";
}
export function createHttpHandler(
  service: ConversationService,
  config: HttpConfiguration,
  assets: ReadonlyMap<
    string,
    { readonly body: string | Uint8Array; readonly type: string }
  > = new Map(),
) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET")
        return json({ status: "ok", mode: config.mode });
      if (url.pathname === "/api/config" && request.method === "GET")
        return json({ ...config, authorization: "mock", handoff: "simulated" });
      if (!url.pathname.startsWith("/api/")) {
        const asset = assets.get(url.pathname);
        return asset && request.method === "GET"
          ? new Response(
              typeof asset.body === "string" ? asset.body : new Uint8Array(asset.body).buffer,
              { headers: { ...headers, "Content-Type": asset.type } },
            )
          : json({ error: "not_found" }, 404);
      }
      const origin = request.headers.get("Origin");
      if (
        (origin && origin !== url.origin) ||
        request.headers.get("Sec-Fetch-Site") === "cross-site"
      )
        throw new RuleViolation("origin_not_allowed");
      if (url.pathname === "/api/sessions" && request.method === "POST") {
        if (!Check(empty, await body(request))) throw new RuleViolation("invalid_request");
        return json(await service.create(), 201);
      }
      const path = url.pathname.match(
        /^\/api\/sessions\/([a-f0-9-]{36})(?:\/(turns|reset|cancel|outbox))?$/,
      );
      if (!path) return json({ error: "not_found" }, 404);
      const access: SessionAccess = {
        sessionId: path[1]!,
        token: request.headers.get("Authorization")?.match(/^Bearer ([a-f0-9-]{72})$/)?.[1] ?? "",
      };
      await service.view(access);
      if (!path[2] && request.method === "GET") return json(await service.view(access));
      if (path[2] === "outbox" && request.method === "GET")
        return json({ deliveries: await service.outbox(access) });
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const input = await body(request);
      if (path[2] === "reset") {
        if (!Check(empty, input)) throw new RuleViolation("invalid_request");
        return json(await service.reset(access));
      }
      if (path[2] === "cancel") {
        if (!Check(cancel, input)) throw new RuleViolation("invalid_request");
        await service.cancel(access, input.requestId);
        return json({ status: "cancelled" });
      }
      if (path[2] !== "turns" || !Check(turn, input) || !input.text.trim())
        throw new RuleViolation("invalid_request");
      const encoder = new TextEncoder();
      let connected = true;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (event: PublicEvent) => {
            if (!connected) return;
            try {
              controller.enqueue(
                encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
              );
            } catch {
              connected = false;
            }
          };
          // A broken transport does not cancel a business side effect. Reconnect with the same requestId.
          void service
            .turn(access, input as TurnInput, emit)
            .catch((error) => {
              emit({ type: "error", requestId: input.requestId, code: safeCode(error) });
            })
            .finally(() => {
              if (connected) {
                connected = false;
                controller.close();
              }
            });
        },
        cancel() {
          connected = false;
        },
      });
      return new Response(stream, {
        headers: { ...headers, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" },
      });
    } catch (error) {
      const code = safeCode(error);
      return json(
        { error: code },
        code === "session_not_found"
          ? 404
          : code === "session_expired"
            ? 410
            : code === "origin_not_allowed"
              ? 403
              : code === "service_unavailable"
                ? 503
                : 400,
      );
    }
  };
}
