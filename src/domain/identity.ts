export const IDENTITY_FIELDS = ["fullName", "dateOfBirth", "phone", "email", "ssnLast4"] as const;
export type IdentityField = (typeof IDENTITY_FIELDS)[number];
export const MINIMUM_IDENTITY_MATCHES = 3;

export function normalizeIdentity(field: IdentityField, value: string): string {
  const text = value.normalize("NFKC").trim();
  if (field === "phone") {
    const digits = text.replace(/\D/g, "");
    return digits.length === 10 ? `1${digits}` : digits;
  }
  if (field === "fullName") return text.toLocaleLowerCase("en-US").replace(/\s+/g, " ");
  if (field === "email") return text.toLocaleLowerCase("en-US");
  return text;
}

/** Compare caller-supplied values without ever returning reference PII. */
export function matchIdentity(
  supplied: Partial<Readonly<Record<IdentityField, string>>>,
  reference: Policyholder,
): IdentityEvidence[] {
  const expected: Record<IdentityField, readonly string[]> = {
    fullName: [reference.fullName, ...reference.nameAliases],
    dateOfBirth: [reference.dateOfBirth],
    phone: [reference.phone, ...reference.phoneAliases],
    email: [reference.email, ...reference.emailAliases],
    ssnLast4: reference.identifier.type === "ssn_last4" ? [reference.identifier.last4] : [],
  };
  return IDENTITY_FIELDS.flatMap((field) => {
    const value = supplied[field];
    if (!value?.trim()) return [];
    return [
      {
        origin: "identity_verifier" as const,
        subjectId: reference.subjectId,
        field,
        outcome: expected[field].some(
          (candidate) => normalizeIdentity(field, candidate) === normalizeIdentity(field, value),
        )
          ? ("match" as const)
          : ("mismatch" as const),
      },
    ];
  });
}

/** Private reference PII used by a verifier; never returned to suggest an answer. */
export interface Policyholder {
  readonly subjectId: string;
  readonly fullName: string;
  readonly nameAliases: readonly string[];
  readonly policyNumber: string;
  readonly dateOfBirth: string;
  readonly identifier: { readonly type: "ssn_last4" | "national_id_last4"; readonly last4: string };
  readonly phone: string;
  readonly phoneAliases: readonly string[];
  readonly email: string;
  readonly emailAliases: readonly string[];
}

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

export function assessIdentityEvidence(evidence: readonly IdentityEvidence[]): IdentityAssessment {
  const matched = new Set<IdentityField>();
  const conflicting = new Set<IdentityField>();
  const subjects = new Set<string>();
  for (const item of evidence) {
    if (
      item.origin !== "identity_verifier" ||
      !item.subjectId ||
      !IDENTITY_FIELDS.includes(item.field) ||
      (item.outcome !== "match" && item.outcome !== "mismatch")
    )
      return {
        status: "conflict",
        reason: "invalid_evidence",
        matchedFields: [],
        conflictingFields: [],
      };
    subjects.add(item.subjectId);
    if (item.outcome === "match") matched.add(item.field);
    else conflicting.add(item.field);
  }
  const matchedFields = [...matched];
  if (subjects.size > 1 || conflicting.size > 0)
    return {
      status: "conflict",
      reason: subjects.size > 1 ? "subject_mismatch" : "field_mismatch",
      matchedFields,
      conflictingFields: [...conflicting],
    };
  const subjectId = subjects.values().next().value;
  if (matched.size >= MINIMUM_IDENTITY_MATCHES && subjectId)
    return { status: "verified", subjectId, matchedFields };
  return { status: "insufficient", matchedFields };
}
