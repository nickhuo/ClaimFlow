import type {
  CallerFacts,
  CaseFacts,
  CaseReference,
  EmailConsent,
  HandoffReason,
  IdentityAssessment,
  Phase,
  RepresentativeAuthorization,
  SopState,
  ToolFact,
} from "../sop/types.ts";

/** Supplied by the server closure, never accepted from model tool arguments. */
export interface BusinessToolContext {
  readonly sessionId: string;
  readonly requestId: string;
  readonly stateVersion: number;
  readonly state: SopState;
  readonly now: number;
}

export interface BusinessToolContracts {
  record_facts: {
    input: { turnId: string; facts: CallerFacts };
    output: { recorded: true };
  };
  verify_identity: {
    input: { turnId: string };
    output: IdentityAssessment;
  };
  request_authorization: {
    input: { turnId: string };
    output: RepresentativeAuthorization;
  };
  resolve_case: {
    input: { turnId: string };
    output:
      | { status: "selected"; case: ToolFact<CaseReference> }
      | { status: "needs_clarification"; question: string };
  };
  read_case: {
    input: { caseId: string };
    output: ToolFact<CaseFacts>;
  };
  document_guidance: {
    input: { caseId: string; question: string };
    output: ToolFact<{ guidance: string }>;
  };
  complete_case: {
    input: { confirmationTurnId: string };
    output: { phase: "POST_PROCESS" };
  };
  set_email_consent: {
    input: { decision: "send" | "skip"; confirmationTurnId: string; summaryVersion: number };
    output: EmailConsent;
  };
  send_summary: {
    input: { summaryVersion: number };
    output: { status: "mock_recorded" | "submitted" | "failed"; deliveryId: string };
  };
  resume_case: {
    input: { turnId: string };
    output: { phase: "PROCESS_CASE" };
  };
  handoff: {
    input: { reason: HandoffReason };
    output: { status: "requested" };
  };
}

export type BusinessToolName = keyof BusinessToolContracts;

export interface BusinessToolHandler<Name extends BusinessToolName> {
  execute(
    input: BusinessToolContracts[Name]["input"],
    context: BusinessToolContext,
    signal?: AbortSignal,
  ): Promise<BusinessToolContracts[Name]["output"]>;
}

export const BUSINESS_TOOL_NAMES = [
  "record_facts",
  "verify_identity",
  "request_authorization",
  "resolve_case",
  "read_case",
  "document_guidance",
  "complete_case",
  "set_email_consent",
  "send_summary",
  "resume_case",
  "handoff",
] as const satisfies readonly BusinessToolName[];

/** Exposure policy only: implementations must also check current identity and ownership. */
export const PHASE_TOOLS = {
  VERIFY_ID: ["record_facts", "verify_identity", "request_authorization", "handoff"],
  RESOLVE_INTENT: ["record_facts", "resolve_case", "handoff"],
  PROCESS_CASE: ["record_facts", "read_case", "document_guidance", "complete_case", "handoff"],
  POST_PROCESS: ["record_facts", "set_email_consent", "send_summary", "resume_case", "handoff"],
} as const satisfies Record<Phase, readonly BusinessToolName[]>;
