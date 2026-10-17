import {
  authorizedSubject,
  collectedFacts,
  transition,
  type ConversationEvent,
  type SopPolicy,
} from "../../domain/conversation.ts";
import type { AuthorizationProvider, BusinessData, Clock } from "../ports.ts";
import type {
  EmailSender,
  ReplyComposer,
  SessionAccess,
  SessionRecord,
  SessionStore,
  TurnInput,
} from "../session-ports.ts";
import { observe, type BusinessObservation } from "../telemetry.ts";
import { PHASE_TOOLS, type BusinessToolName } from "../tool-contracts.ts";
import { confirmsCompletion, emailDecision, requestsHuman } from "./user-turn.ts";

export interface BusinessDependencies {
  readonly store: SessionStore;
  readonly data: BusinessData;
  readonly authorization: AuthorizationProvider;
  readonly email: EmailSender;
  readonly clock: Clock;
  readonly policy: SopPolicy;
  readonly replyComposer?: ReplyComposer;
  readonly observe?: (event: BusinessObservation) => void;
}

export class BusinessContext {
  #transitions = 0;
  clarification: string | null = null;
  authorizationChecked = false;
  deliveryAttempted = false;
  readonly operations: {
    tool: BusinessToolName | "unknown";
    outcome: "success" | "denied" | "error";
    reason: string | null;
  }[] = [];
  constructor(
    readonly dependencies: BusinessDependencies,
    readonly access: SessionAccess,
    readonly input: TurnInput,
    readonly signal: AbortSignal,
    readonly assertCurrent: () => void,
  ) {}
  read(): SessionRecord {
    this.assertCurrent();
    this.signal.throwIfAborted();
    return this.dependencies.store.read(this.access, this.dependencies.clock.now());
  }
  subject(): string {
    return authorizedSubject(
      this.read().state,
      this.dependencies.clock.now(),
      this.dependencies.policy,
    );
  }
  commit(event: ConversationEvent): SessionRecord {
    const current = this.read();
    const now = this.dependencies.clock.now();
    const state = transition(current.state, event, now, this.dependencies.policy);
    if (state.phase !== current.state.phase && ++this.#transitions > 8)
      throw new Error("run_limit");
    const saved = this.dependencies.store.save(
      this.access,
      current.version,
      state,
      now,
      this.dependencies.policy.sessionIdleTimeoutMs,
    );
    let verified = false;
    try {
      authorizedSubject(state, now, this.dependencies.policy);
      verified = true;
    } catch {
      /* Redacted authority status only. */
    }
    observe(this.dependencies.observe, {
      type: "state_transition",
      from: current.state.phase,
      to: state.phase,
      version: saved.version,
      status: state.status,
      verified,
      distinctMatches: new Set(
        state.evidence.filter((item) => item.outcome === "match").map((item) => item.field),
      ).size,
      summaryVersion: state.summary?.version ?? null,
    });
    return saved;
  }
  projection(): string {
    const { state, version } = this.read();
    const facts = collectedFacts(state);
    let subject: string | null = null;
    try {
      subject = authorizedSubject(state, this.dependencies.clock.now(), this.dependencies.policy);
    } catch {
      /* No protected projection. */
    }
    return JSON.stringify({
      version,
      phase: state.phase,
      status: state.status,
      operationsThisTurn: this.operations,
      availableTools: this.availableTools(),
      identity: state.identity.status,
      recordedThisTurn: state.callerFacts.some((item) => item.turnId === this.input.requestId),
      verifiedThisTurn: state.identityAudit.some((item) => item.turnId === this.input.requestId),
      authorizationCheckedThisTurn: this.authorizationChecked,
      deliveryAttemptedThisTurn: this.deliveryAttempted,
      role: facts.role ?? "policyholder",
      collectedIdentityFields: Object.keys(facts.identity ?? {}),
      matchedIdentityFields: state.evidence
        .filter((item) => item.outcome === "match")
        .map((item) => item.field),
      conflictingIdentityFields: state.evidence
        .filter((item) => item.outcome === "mismatch")
        .map((item) => item.field),
      authorization: state.representativeAuthorization.status,
      intent: facts.intent ?? null,
      hints: facts.caseHints ?? {},
      selectedCaseId: state.selectedCase?.value.caseId ?? null,
      summaryVersion: state.summary?.version ?? null,
      emailConsent: state.emailConsent.status,
      delivery: state.delivery?.status ?? null,
      emailConsentThisTurn:
        state.emailConsent.status === "granted" &&
        state.emailConsent.confirmationTurnId === this.input.requestId,
      caseReadThisTurn: state.caseFacts?.operationId === this.input.requestId,
      guidanceReadThisTurn: state.guidance?.operationId === this.input.requestId,
      topic: facts.topic ?? null,
      clarification: this.clarification,
      caseFacts: subject ? (state.caseFacts?.value ?? null) : null,
      documentGuidance: subject ? (state.guidance?.value ?? null) : null,
    });
  }

  availableTools(): BusinessToolName[] {
    const { state } = this.read();
    const completed = new Set(
      this.operations.filter((item) => item.outcome === "success").map((item) => item.tool),
    );
    if (
      state.status === "handoff_requested" ||
      completed.has("complete_case") ||
      completed.has("send_summary") ||
      (completed.has("set_email_consent") && state.emailConsent.status === "declined")
    )
      return [];
    if (state.status === "completed") return ["resume_case", "handoff"];
    const facts = collectedFacts(state);
    if (completed.has("record_facts") && facts.scope === "out_of_scope") return [];
    return PHASE_TOOLS[state.phase].filter((name) => {
      if (completed.has(name)) return false;
      switch (name) {
        case "complete_case":
          return confirmsCompletion(this.input);
        case "resolve_case":
          return state.phase === "RESOLVE_INTENT" && !this.clarification;
        case "document_guidance":
          return ["documents", "alternatives", "submission", "processing_time"].includes(
            facts.topic ?? "",
          );
        case "set_email_consent":
          return (
            emailDecision(this.input) !== null &&
            !["unknown", "pending"].includes(state.delivery?.status ?? "")
          );
        case "send_summary":
          return (
            state.emailConsent.status === "granted" &&
            (emailDecision(this.input) === "send" ||
              ["unknown", "pending"].includes(state.delivery?.status ?? ""))
          );
        case "resume_case":
          return emailDecision(this.input) === null && !confirmsCompletion(this.input);
        case "handoff":
          return (
            requestsHuman(this.input) ||
            (facts.topic === "alternatives" &&
              Boolean(state.guidance) &&
              /none|no (copies|alternatives)|cannot (get|obtain)/i.test(this.input.text))
          );
        case "request_authorization":
          return facts.role === "representative" && state.identity.status === "verified";
        case "verify_identity":
          return (
            state.identity.status !== "verified" && Object.keys(facts.identity ?? {}).length > 0
          );
        default:
          return true;
      }
    });
  }
}
