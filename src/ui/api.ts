import { createParser } from "eventsource-parser";
import type {
  PublicEvent,
  SessionAccess,
  SessionView,
  TurnInput,
  TurnResult,
} from "../application/session-ports.ts";

export type Session = SessionAccess & { view: SessionView };
export interface Configuration {
  mode: "demo" | "live";
  email: "mock" | "external";
}
export interface OutboxItem {
  id: string;
  summaryVersion: number;
  recipient: string;
  body: string;
  status: string;
  createdAt: number;
}
const messages: Record<string, string> = {
  session_expired: "This conversation has expired. Start a new conversation to verify again.",
  session_not_found: "This conversation is no longer available. Start a new conversation.",
  stale_request: "Your conversation has moved on. Please send your question again.",
  verification_required: "Verify your identity before opening the outbox.",
  request_id_conflict: "This message could not be retried. Please send it again.",
  invalid_request: "Please check your message and try again.",
  service_unavailable: "We couldn't reach the assistant. Please try again in a moment.",
};
export class ApiError extends Error {
  constructor(readonly code: string) {
    super(messages[code] ?? messages.service_unavailable);
  }
}
function headers(access?: SessionAccess) {
  return {
    "Content-Type": "application/json",
    ...(access ? { Authorization: `Bearer ${access.token}` } : {}),
  };
}
export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  access?: SessionAccess,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: headers(access),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw new ApiError(value.error);
  return value as T;
}
export const sessionPath = (access: SessionAccess, suffix = "") =>
  `/api/sessions/${access.sessionId}${suffix}`;
export function remember(session: Session) {
  // Transcripts and identity details stay out of browser storage.
  sessionStorage.setItem(
    "claims-session",
    JSON.stringify({ sessionId: session.sessionId, token: session.token }),
  );
  return session;
}
export async function openSession(): Promise<Session> {
  let access: SessionAccess | undefined;
  try {
    access = JSON.parse(sessionStorage.getItem("claims-session") ?? "null") ?? undefined;
  } catch {
    sessionStorage.removeItem("claims-session");
  }
  if (access?.sessionId && access.token) {
    try {
      return {
        ...access,
        view: await request<SessionView>(sessionPath(access), "GET", undefined, access),
      };
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        !["session_expired", "session_not_found"].includes(error.code)
      )
        throw error;
    }
  }
  return remember(await request<Session>("/api/sessions", "POST", {}));
}
export async function streamTurn(
  access: SessionAccess,
  input: TurnInput,
  signal: AbortSignal,
  progress: (event: PublicEvent) => void,
): Promise<TurnResult> {
  const response = await fetch(sessionPath(access, "/turns"), {
    method: "POST",
    headers: headers(access),
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) throw new ApiError((await response.json()).error);
  if (!response.body) throw new ApiError("service_unavailable");
  let result: TurnResult | undefined;
  const parser = createParser({
    onEvent(event) {
      const value = JSON.parse(event.data) as PublicEvent;
      if (value.requestId !== input.requestId) return;
      if (value.type === "error") throw new ApiError(value.code);
      if (value.type === "result") result = value.result;
      progress(value);
    },
  });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parser.feed(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!result) throw new ApiError("service_unavailable");
  return result;
}
