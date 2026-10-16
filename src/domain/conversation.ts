import type { RepresentativeAuthorization } from "./authorization.ts";
import type { CaseFacts, CaseHints, CaseReference } from "./claims.ts";
import type { FactSource, ToolFact, UserStatement } from "./facts.ts";
import {
  assessIdentityEvidence,
  normalizeIdentity,
  type IdentityEvidence,
  type IdentityField,
  type IdentityVerification,
} from "./identity.ts";

export const SOP_PHASES = ["VERIFY_ID", "RESOLVE_INTENT", "PROCESS_CASE", "POST_PROCESS"] as const;
export type Phase = (typeof SOP_PHASES)[number];
export const INTENTS = [
  "status_inquiry",
  "denial_question",
  "document_submission",
  "next_steps",
  "general_claim_question",
] as const;
export type Intent = (typeof INTENTS)[number];
export const HANDOFF_REASONS = [
  "identity_failures",
  "identity_refusal",
  "authorization_missing",
  "authorization_timeout",
  "repeated_off_topic",
  "documents_unavailable",
  "caller_request",
  "service_unavailable",
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export type EmailConsent =
  | { readonly status: "not_asked" | "awaiting_choice" | "declined" }
  | {
      readonly status: "granted";
      readonly recipient: string;
      readonly summaryVersion: number;
      readonly confirmationTurnId: string;
    };

export interface CallerFacts {
  readonly role?: "policyholder" | "representative";
  readonly identity?: Partial<Readonly<Record<IdentityField, string>>>;
  readonly policyNumber?: string;
  readonly intent?: Intent;
  readonly caseHints?: CaseHints;
  readonly representedPolicyNumber?: string;
  readonly scope?: "in_scope" | "out_of_scope" | "mixed" | "unclear";
  readonly emotion?: "calm" | "frustrated" | "anxious" | "confused" | "refusing";
  readonly topic?:
    | "status"
    | "denial"
    | "amounts"
    | "documents"
    | "alternatives"
    | "deadline"
    | "submission"
    | "processing_time"
    | "unknown";
}

export interface SopPolicy {
  readonly maxIdentityFailures: number;
  readonly maxConsecutiveOffTopic: number;
  readonly authorizationTimeoutMs: number;
  readonly sessionIdleTimeoutMs: number;
}

export const DEFAULT_SOP_POLICY: Readonly<SopPolicy> = Object.freeze({
  maxIdentityFailures: 3,
  maxConsecutiveOffTopic: 3,
  authorizationTimeoutMs: 30_000,
  sessionIdleTimeoutMs: 30 * 60_000,
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

export class RuleViolation extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RuleViolation";
  }
}

export interface ConversationState extends SopState {
  readonly evidence: readonly IdentityEvidence[];
  readonly identityAudit: readonly {
    readonly turnId: string;
    readonly checkedAt: number;
    readonly evidence: readonly IdentityEvidence[];
    readonly sources: readonly FactSource[];
  }[];
  readonly identityFailures: number;
  readonly consecutiveIdentityRefusals: number;
  readonly failedIdentityTurns: readonly string[];
  readonly consecutiveOffTopic: number;
  readonly classifiedTurns: readonly string[];
  readonly caseFacts: ToolFact<CaseFacts> | null;
  readonly guidance: ToolFact<{ readonly guidance: string }> | null;
  readonly discussedTopics: readonly string[];
  readonly summary: { readonly version: number; readonly text: string } | null;
  readonly summaryRevision: number;
  readonly delivery: {
    readonly deliveryId: string;
    readonly status: "pending" | "mock_recorded" | "submitted" | "failed" | "unknown";
  } | null;
  readonly handoffReason: HandoffReason | null;
}

export function initialConversation(): ConversationState {
  return {
    phase: "VERIFY_ID",
    status: "active",
    identity: { status: "unverified" },
    representativeAuthorization: { status: "not_required" },
    emailConsent: { status: "not_asked" },
    callerFacts: [],
    selectedCase: null,
    evidence: [],
    identityAudit: [],
    identityFailures: 0,
    consecutiveIdentityRefusals: 0,
    failedIdentityTurns: [],
    consecutiveOffTopic: 0,
    classifiedTurns: [],
    caseFacts: null,
    guidance: null,
    discussedTopics: [],
    summary: null,
    summaryRevision: 0,
    delivery: null,
    handoffReason: null,
  };
}

export function collectedFacts(state: SopState): CallerFacts {
  return state.callerFacts.reduce<CallerFacts>(
    (facts, statement) => ({
      ...facts,
      ...statement.value,
      identity: { ...facts.identity, ...statement.value.identity },
      caseHints:
        statement.value.caseHints?.caseId ||
        (statement.value.caseHints?.caseType &&
          statement.value.caseHints.caseType !== facts.caseHints?.caseType)
          ? { ...statement.value.caseHints }
          : { ...facts.caseHints, ...statement.value.caseHints },
    }),
    {},
  );
}

export function authorizedSubject(
  state: SopState,
  now: number,
  policy: SopPolicy = DEFAULT_SOP_POLICY,
): string {
  if (state.status === "handoff_requested") throw new RuleViolation("handoff_requested");
  if (
    state.identity.status !== "verified" ||
    now >= state.identity.verifiedAt + policy.sessionIdleTimeoutMs
  ) {
    throw new RuleViolation("verification_required");
  }
  if (collectedFacts(state).role !== "representative") return state.identity.subjectId;
  const grant = state.representativeAuthorization;
  if (
    grant.status !== "approved" ||
    grant.expiresAt <= now ||
    grant.scope !== "claims:read" ||
    grant.representativeId !== state.identity.subjectId
  ) {
    throw new RuleViolation("authorization_required");
  }
  return grant.subjectId;
}

export type ConversationEvent =
  | { readonly type: "record"; readonly turnId: string; readonly facts: CallerFacts }
  | {
      readonly type: "identity_checked";
      readonly turnId: string;
      readonly evidence: readonly IdentityEvidence[];
      readonly sources: readonly FactSource[];
    }
  | { readonly type: "authorization_checked"; readonly authorization: RepresentativeAuthorization }
  | { readonly type: "case_selected"; readonly fact: ToolFact<CaseReference> }
  | { readonly type: "case_read"; readonly fact: ToolFact<CaseFacts>; readonly topic: string }
  | { readonly type: "guidance_read"; readonly fact: ToolFact<{ readonly guidance: string }> }
  | { readonly type: "finish"; readonly confirmed: boolean; readonly summary: string }
  | {
      readonly type: "email_choice";
      readonly decision: "send" | "skip";
      readonly confirmed: boolean;
      readonly recipient: string;
      readonly summaryVersion: number;
      readonly turnId: string;
    }
  | {
      readonly type: "delivery_updated";
      readonly delivery: NonNullable<ConversationState["delivery"]>;
      readonly summaryVersion: number;
    }
  | { readonly type: "resume" }
  | { readonly type: "handoff"; readonly reason: HandoffReason };

/** Only trusted application operations produce these events; every transition checks domain invariants. */
export function transition(
  state: ConversationState,
  event: ConversationEvent,
  now: number,
  policy: SopPolicy = DEFAULT_SOP_POLICY,
): ConversationState {
  if (state.status === "handoff_requested") throw new RuleViolation("handoff_requested");
  let next = structuredClone(state);
  const active = () => {
    if (state.status !== "active") throw new RuleViolation("conversation_completed");
  };
  const access = () => authorizedSubject(state, now, policy);
  const phase = (...allowed: Phase[]) => {
    if (!allowed.includes(state.phase)) throw new RuleViolation("action_not_available");
  };
  switch (event.type) {
    case "record": {
      active();
      const old = collectedFacts(state);
      const changedCaller =
        (event.facts.role && event.facts.role !== (old.role ?? "policyholder")) ||
        (event.facts.policyNumber &&
          (old.policyNumber || state.identity.status === "verified") &&
          event.facts.policyNumber !== old.policyNumber) ||
        (event.facts.representedPolicyNumber &&
          (old.representedPolicyNumber || state.identity.status === "verified") &&
          event.facts.representedPolicyNumber !== old.representedPolicyNumber);
      if (changedCaller)
        next = {
          ...initialConversation(),
          identityAudit: state.identityAudit,
          summaryRevision: state.summaryRevision,
        };
      const changedIdentity = Object.entries(event.facts.identity ?? {}).some(
        ([field, value]) =>
          normalizeIdentity(field as IdentityField, value) !==
          normalizeIdentity(field as IdentityField, old.identity?.[field as IdentityField] ?? ""),
      );
      if (changedIdentity && next.identity.status === "verified")
        next = {
          ...next,
          phase: "VERIFY_ID",
          identity: { status: "unverified" },
          representativeAuthorization: { status: "not_required" },
          selectedCase: null,
          caseFacts: null,
          guidance: null,
          summary: null,
          emailConsent: { status: "not_asked" },
        };
      const changedCase = Object.entries(event.facts.caseHints ?? {}).some(
        ([key, value]) => value !== old.caseHints?.[key as keyof CaseHints],
      );
      if (
        !state.callerFacts.some((item) => item.turnId === event.turnId) &&
        next.phase === "VERIFY_ID"
      ) {
        const count = Object.keys(event.facts.identity ?? {}).length
          ? 0
          : event.facts.emotion === "refusing"
            ? next.consecutiveIdentityRefusals + 1
            : next.consecutiveIdentityRefusals;
        next = { ...next, consecutiveIdentityRefusals: count };
        if (count >= policy.maxIdentityFailures)
          next = { ...next, status: "handoff_requested", handoffReason: "identity_refusal" };
      }
      if (changedCase && next.phase === "PROCESS_CASE")
        next = {
          ...next,
          phase: "RESOLVE_INTENT",
          selectedCase: null,
          caseFacts: null,
          guidance: null,
          discussedTopics: [],
          summary: null,
          emailConsent: { status: "not_asked" },
        };
      const { topic: incomingTopic, ...otherFacts } = event.facts;
      const recordedFacts =
        next.phase === "VERIFY_ID" &&
        incomingTopic === "unknown" &&
        Object.keys(event.facts.identity ?? {}).length > 0
          ? otherFacts
          : event.facts;
      next = {
        ...next,
        callerFacts: [
          ...next.callerFacts,
          { origin: "user", turnId: event.turnId, value: structuredClone(recordedFacts) },
        ],
      };
      if (event.facts.scope && !next.classifiedTurns.includes(event.turnId)) {
        const count =
          event.facts.scope === "out_of_scope"
            ? next.consecutiveOffTopic + 1
            : event.facts.scope === "unclear"
              ? next.consecutiveOffTopic
              : 0;
        next = {
          ...next,
          classifiedTurns: [...next.classifiedTurns, event.turnId],
          consecutiveOffTopic: count,
        };
        if (count >= policy.maxConsecutiveOffTopic)
          next = { ...next, status: "handoff_requested", handoffReason: "repeated_off_topic" };
      }
      return next;
    }
    case "identity_checked": {
      active();
      phase("VERIFY_ID", "RESOLVE_INTENT", "PROCESS_CASE");
      const fields = new Set(event.evidence.map((item) => item.field));
      const evidence = [
        ...state.evidence.filter((item) => !fields.has(item.field)),
        ...event.evidence,
      ];
      const result = assessIdentityEvidence(evidence);
      const failed =
        result.status === "conflict" && !state.failedIdentityTurns.includes(event.turnId);
      const failures = result.status === "verified" ? 0 : state.identityFailures + Number(failed);
      next = {
        ...next,
        evidence,
        identityFailures: failures,
        identityAudit: [
          ...state.identityAudit,
          {
            turnId: event.turnId,
            checkedAt: now,
            evidence: structuredClone(event.evidence),
            sources: structuredClone(event.sources),
          },
        ],
        failedIdentityTurns: failed
          ? [...state.failedIdentityTurns, event.turnId]
          : state.failedIdentityTurns,
        identity:
          result.status === "verified" ? { ...result, verifiedAt: now } : { status: "unverified" },
      };
      if (result.status !== "verified")
        next = {
          ...next,
          phase: "VERIFY_ID",
          selectedCase: null,
          caseFacts: null,
          guidance: null,
          summary: null,
          emailConsent: { status: "not_asked" },
        };
      else if (state.phase === "VERIFY_ID" && collectedFacts(next).role !== "representative")
        next = { ...next, phase: "RESOLVE_INTENT" };
      if (failures >= policy.maxIdentityFailures)
        next = { ...next, status: "handoff_requested", handoffReason: "identity_failures" };
      return next;
    }
    case "authorization_checked": {
      active();
      phase("VERIFY_ID");
      if (collectedFacts(state).role !== "representative")
        throw new RuleViolation("authorization_not_required");
      const grant = event.authorization;
      if (
        grant.status === "approved" &&
        (state.identity.status !== "verified" ||
          grant.representativeId !== state.identity.subjectId ||
          grant.expiresAt <= now)
      )
        throw new RuleViolation("authorization_required");
      next = { ...next, representativeAuthorization: structuredClone(grant) };
      if (grant.status === "approved") {
        authorizedSubject(next, now, policy);
        next = { ...next, phase: "RESOLVE_INTENT" };
      }
      if (grant.status === "denied" || grant.status === "expired")
        next = {
          ...next,
          status: "handoff_requested",
          handoffReason:
            grant.status === "expired" ? "authorization_timeout" : "authorization_missing",
        };
      return next;
    }
    case "case_selected":
      active();
      phase("RESOLVE_INTENT", "PROCESS_CASE");
      if (event.fact.value.subjectId !== access() || !collectedFacts(state).intent)
        throw new RuleViolation("case_unavailable");
      return {
        ...next,
        phase: "PROCESS_CASE",
        selectedCase: structuredClone(event.fact),
        caseFacts: null,
        guidance: null,
        discussedTopics: [],
        summary: null,
        emailConsent: { status: "not_asked" },
      };
    case "case_read":
      active();
      phase("PROCESS_CASE");
      if (
        event.fact.value.subjectId !== access() ||
        event.fact.value.caseId !== state.selectedCase?.value.caseId
      )
        throw new RuleViolation("case_unavailable");
      return {
        ...next,
        caseFacts: structuredClone(event.fact),
        discussedTopics: [...new Set([...state.discussedTopics, event.topic])],
      };
    case "guidance_read":
      active();
      phase("PROCESS_CASE");
      access();
      if (!state.caseFacts) throw new RuleViolation("case_unavailable");
      return {
        ...next,
        guidance: structuredClone(event.fact),
        discussedTopics: [...new Set([...state.discussedTopics, "documents"])],
      };
    case "finish":
      active();
      phase("PROCESS_CASE");
      access();
      if (!event.confirmed || !state.caseFacts || !event.summary.trim())
        throw new RuleViolation("completion_confirmation_required");
      return {
        ...next,
        phase: "POST_PROCESS",
        summaryRevision: state.summaryRevision + 1,
        summary: { version: state.summaryRevision + 1, text: event.summary },
        emailConsent: { status: "awaiting_choice" },
        delivery: null,
      };
    case "email_choice":
      active();
      phase("POST_PROCESS");
      access();
      if (!event.confirmed || !state.summary || event.summaryVersion !== state.summary.version)
        throw new RuleViolation("current_summary_consent_required");
      if (state.delivery?.status === "pending" || state.delivery?.status === "unknown")
        throw new RuleViolation("delivery_unresolved");
      if (event.decision === "skip")
        return { ...next, status: "completed", emailConsent: { status: "declined" } };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(event.recipient))
        throw new RuleViolation("recipient_required");
      return {
        ...next,
        emailConsent: {
          status: "granted",
          recipient: event.recipient,
          summaryVersion: event.summaryVersion,
          confirmationTurnId: event.turnId,
        },
      };
    case "delivery_updated":
      phase("POST_PROCESS");
      access();
      if (
        state.emailConsent.status !== "granted" ||
        state.summary?.version !== event.summaryVersion ||
        state.emailConsent.summaryVersion !== event.summaryVersion
      )
        throw new RuleViolation("current_summary_consent_required");
      return {
        ...next,
        delivery: structuredClone(event.delivery),
        status: ["mock_recorded", "submitted"].includes(event.delivery.status)
          ? "completed"
          : "active",
      };
    case "resume":
      phase("POST_PROCESS");
      access();
      if (!state.selectedCase) throw new RuleViolation("case_unavailable");
      if (state.delivery?.status === "pending" || state.delivery?.status === "unknown")
        throw new RuleViolation("delivery_unresolved");
      return {
        ...next,
        phase: "PROCESS_CASE",
        status: "active",
        summary: null,
        emailConsent: { status: "not_asked" },
        delivery: null,
      };
    case "handoff":
      return { ...next, status: "handoff_requested", handoffReason: event.reason };
  }
}
