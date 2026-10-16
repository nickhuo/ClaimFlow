export const SOP_PHASES = [
  "VERIFY_ID",
  "RESOLVE_INTENT",
  "PROCESS_CASE",
  "POST_PROCESS",
] as const;

export type Phase = (typeof SOP_PHASES)[number];

export const IDENTITY_FIELDS = [
  "fullName",
  "dateOfBirth",
  "phone",
  "email",
  "ssnLast4",
] as const;

export type IdentityField = (typeof IDENTITY_FIELDS)[number];

/** User statements are hints, never proof of identity, authorization, or a claim fact. */
export interface UserStatement<T> {
  readonly origin: "user";
  readonly turnId: string;
  readonly value: T;
}

export interface ToolFact<T> {
  readonly origin: "tool";
  readonly toolName: string;
  readonly operationId: string;
  readonly observedAt: number;
  readonly value: T;
}

/** Produced by a server-side verifier; no stored PII is returned in this evidence. */
export interface IdentityEvidence {
  readonly origin: "identity_verifier";
  readonly subjectId: string;
  readonly field: IdentityField;
  readonly outcome: "match" | "mismatch";
}

export type IdentityAssessment =
  | { readonly status: "insufficient"; readonly matchedFields: readonly IdentityField[] }
  | {
      readonly status: "conflict";
      readonly matchedFields: readonly IdentityField[];
      readonly conflictingFields: readonly IdentityField[];
      readonly reason: "field_mismatch" | "subject_mismatch" | "invalid_evidence";
    }
  | {
      readonly status: "verified";
      readonly subjectId: string;
      readonly matchedFields: readonly IdentityField[];
    };

export type IdentityVerification =
  | { readonly status: "unverified" }
  | {
      readonly status: "verified";
      readonly subjectId: string;
      readonly verifiedAt: number;
      readonly matchedFields: readonly IdentityField[];
    };

export type RepresentativeAuthorization =
  | { readonly status: "not_required" }
  | { readonly status: "pending"; readonly requestedAt: number }
  | { readonly status: "denied" | "expired" }
  | {
      readonly status: "approved";
      readonly subjectId: string;
      readonly representativeId: string;
      readonly grantId: string;
      readonly scope: "claims:read";
      readonly expiresAt: number;
      readonly source: "mock" | "external";
    };

export type EmailConsent =
  | { readonly status: "not_asked" | "awaiting_choice" | "declined" }
  | {
      readonly status: "granted";
      readonly recipient: string;
      readonly summaryVersion: number;
      readonly confirmationTurnId: string;
    };

export type Intent =
  | "status_inquiry"
  | "denial_question"
  | "document_submission"
  | "next_steps"
  | "general_claim_question";

export interface CaseHints {
  readonly caseId?: string;
  readonly caseType?: "healthcare" | "auto";
  readonly month?: string;
  readonly claimedStatus?: string;
}

export interface CallerFacts {
  readonly role?: "policyholder" | "representative";
  readonly identity?: Partial<Readonly<Record<IdentityField, string>>>;
  readonly policyNumber?: string;
  readonly intent?: Intent;
  readonly caseHints?: CaseHints;
}

export interface CaseReference {
  readonly caseId: string;
  readonly subjectId: string;
}

export interface CaseFacts extends CaseReference {
  readonly status: string;
  readonly summary: string;
  readonly denialReason: string | null;
  readonly documentsNeeded: readonly string[];
  readonly appealDeadline: string | null;
  /** Decimal strings in USD, matching the fixture contract. */
  readonly amounts: Readonly<Record<string, string>>;
}

export type HandoffReason =
  | "identity_failures"
  | "authorization_missing"
  | "authorization_timeout"
  | "repeated_off_topic"
  | "documents_unavailable"
  | "caller_request"
  | "service_unavailable";

/** Business state is separate from Pi's conversation transcript and compaction. */
export interface SopState {
  readonly phase: Phase;
  readonly status: "active" | "completed" | "handoff_requested";
  readonly identity: IdentityVerification;
  readonly representativeAuthorization: RepresentativeAuthorization;
  readonly emailConsent: EmailConsent;
  readonly callerFacts: readonly UserStatement<CallerFacts>[];
  readonly selectedCase: ToolFact<CaseReference> | null;
}
