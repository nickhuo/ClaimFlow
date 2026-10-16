import type { RepresentativeAuthorization } from "./authorization.ts";
import type { CaseHints, CaseReference } from "./claims.ts";
import type { ToolFact, UserStatement } from "./facts.ts";
import type { IdentityField, IdentityVerification } from "./identity.ts";

export const SOP_PHASES = ["VERIFY_ID", "RESOLVE_INTENT", "PROCESS_CASE", "POST_PROCESS"] as const;
export type Phase = (typeof SOP_PHASES)[number];
export const INTENTS = ["status_inquiry", "denial_question", "document_submission", "next_steps", "general_claim_question"] as const;
export type Intent = (typeof INTENTS)[number];
export const HANDOFF_REASONS = [
  "identity_failures", "authorization_missing", "authorization_timeout", "repeated_off_topic",
  "documents_unavailable", "caller_request", "service_unavailable",
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export type EmailConsent =
  | { readonly status: "not_asked" | "awaiting_choice" | "declined" }
  | { readonly status: "granted"; readonly recipient: string; readonly summaryVersion: number; readonly confirmationTurnId: string };

export interface CallerFacts {
  readonly role?: "policyholder" | "representative";
  readonly identity?: Partial<Readonly<Record<IdentityField, string>>>;
  readonly policyNumber?: string;
  readonly intent?: Intent;
  readonly caseHints?: CaseHints;
}

export interface SopPolicy {
  readonly maxIdentityFailures: number;
  readonly maxConsecutiveOffTopic: number;
  readonly authorizationTimeoutMs: number;
  readonly sessionIdleTimeoutMs: number;
}

export const DEFAULT_SOP_POLICY: Readonly<SopPolicy> = Object.freeze({
  maxIdentityFailures: 3, maxConsecutiveOffTopic: 3,
  authorizationTimeoutMs: 30_000, sessionIdleTimeoutMs: 30 * 60_000,
});

/** Business state stays independent of a conversation harness or transcript. */
export interface SopState {
  readonly phase: Phase;
  readonly status: "active" | "completed" | "handoff_requested";
  readonly identity: IdentityVerification;
  readonly representativeAuthorization: RepresentativeAuthorization;
  readonly emailConsent: EmailConsent;
  readonly callerFacts: readonly UserStatement<CallerFacts>[];
  readonly selectedCase: ToolFact<CaseReference> | null;
}
