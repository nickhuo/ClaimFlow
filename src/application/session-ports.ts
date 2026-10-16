import type { ConversationState, Phase } from "../domain/conversation.ts";

export interface SessionAccess {
  readonly sessionId: string;
  readonly token: string;
}
export interface SessionRecord {
  readonly id: string;
  readonly version: number;
  readonly expiresAt: number;
  readonly state: ConversationState;
}
export interface SessionView {
  readonly sessionId: string;
  readonly version: number;
  readonly phase: Phase;
  readonly status: ConversationState["status"];
  readonly verified: boolean;
  readonly authorization: "not_required" | "pending" | "approved" | "denied" | "expired";
  readonly summary: ConversationState["summary"];
  readonly delivery: ConversationState["delivery"];
  readonly handoff: {
    readonly status: "requested";
    readonly simulated: true;
    readonly reason: string;
  } | null;
}
export interface TurnInput {
  readonly requestId: string;
  readonly text: string;
  readonly action?:
    | { readonly type: "finish" | "handoff" | "resume" }
    | {
        readonly type: "send" | "skip" | "check_delivery";
        readonly summaryVersion: number;
        readonly recipient?: string;
      };
}
export interface TurnResult {
  readonly requestId: string;
  readonly view: SessionView;
  readonly reply: string;
  readonly error: "model_unavailable" | "run_limit" | "cancelled" | null;
}
export type PublicEvent =
  | { readonly type: "waiting"; readonly requestId: string }
  | {
      readonly type: "progress";
      readonly requestId: string;
      readonly phase: Phase;
      readonly activity:
        | "verifying"
        | "authorization"
        | "locating"
        | "reading"
        | "preparing"
        | "sending"
        | "handoff";
    }
  | { readonly type: "result"; readonly requestId: string; readonly result: TurnResult }
  | { readonly type: "error"; readonly requestId: string; readonly code: string };

export interface DeliveryRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly subjectId: string;
  readonly summaryVersion: number;
  readonly recipient: string;
  readonly body: string;
  readonly status: "pending" | "mock_recorded" | "submitted" | "failed" | "unknown";
  readonly createdAt: number;
}

/** SQLite implements atomic CAS and a durable idempotency ledger. No model transcript is stored here. */
export interface SessionStore {
  create(
    state: ConversationState,
    now: number,
    ttl: number,
  ): { access: SessionAccess; record: SessionRecord };
  read(access: SessionAccess, now: number): SessionRecord;
  save(
    access: SessionAccess,
    expectedVersion: number,
    state: ConversationState,
    now: number,
    ttl: number,
  ): SessionRecord;
  revoke(access: SessionAccess, now: number): void;
  beginRequest(access: SessionAccess, input: TurnInput, now: number): TurnResult | null;
  finishRequest(access: SessionAccess, result: TurnResult, now: number): void;
  reserveDelivery(
    access: SessionAccess,
    expectedVersion: number,
    now: number,
  ): { record: DeliveryRecord; attempt: boolean };
  updateDelivery(id: string, status: DeliveryRecord["status"]): DeliveryRecord;
  deliveries(access: SessionAccess, now: number): readonly DeliveryRecord[];
  close(): void;
}

export interface EmailSender {
  readonly mode: "mock" | "external";
  send(
    delivery: DeliveryRecord,
    signal?: AbortSignal,
  ): Promise<"mock_recorded" | "submitted" | "failed" | "unknown">;
  reconcile(
    delivery: DeliveryRecord,
  ): Promise<"mock_recorded" | "submitted" | "failed" | "unknown">;
}

export interface HarnessRun {
  readonly input: TurnInput;
  readonly signal: AbortSignal;
  readonly context: () => string;
  readonly authorize: (name: string, input: unknown) => void;
  readonly execute: (name: string, input: unknown) => Promise<unknown>;
  readonly onProgress: (activity: Extract<PublicEvent, { type: "progress" }>["activity"]) => void;
}
export interface ConversationHarness {
  run(run: HarnessRun): Promise<void>;
  close(): Promise<void>;
}
export interface HarnessFactory {
  create(): Promise<ConversationHarness>;
}
