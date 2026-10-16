import {
  IDENTITY_FIELDS,
  type IdentityAssessment,
  type IdentityEvidence,
  type IdentityField,
} from "./types.ts";

export const MINIMUM_IDENTITY_MATCHES = 3;

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

const POLICY_ENV = {
  maxIdentityFailures: "MAX_IDENTITY_FAILURES",
  maxConsecutiveOffTopic: "MAX_CONSECUTIVE_OFF_TOPIC",
  authorizationTimeoutMs: "AUTHORIZATION_TIMEOUT_MS",
  sessionIdleTimeoutMs: "SESSION_IDLE_TIMEOUT_MS",
} as const satisfies Record<keyof SopPolicy, string>;

export function readSopPolicy(env: Readonly<Record<string, string | undefined>>): SopPolicy {
  const policy = { ...DEFAULT_SOP_POLICY };
  for (const key of Object.keys(POLICY_ENV) as (keyof SopPolicy)[]) {
    const name = POLICY_ENV[key];
    const raw = env[name];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) {
      throw new Error(`${name} must be a positive safe integer`);
    }
    policy[key] = value;
  }
  return Object.freeze(policy);
}

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
    ) {
      return { status: "conflict", reason: "invalid_evidence", matchedFields: [], conflictingFields: [] };
    }
    subjects.add(item.subjectId);
    if (item.outcome === "match") matched.add(item.field);
    else conflicting.add(item.field);
  }
  const matchedFields = [...matched];
  if (subjects.size > 1 || conflicting.size > 0) {
    return {
      status: "conflict",
      reason: subjects.size > 1 ? "subject_mismatch" : "field_mismatch",
      matchedFields,
      conflictingFields: [...conflicting],
    };
  }
  const subjectId = subjects.values().next().value;
  if (matched.size >= MINIMUM_IDENTITY_MATCHES && subjectId) {
    return { status: "verified", subjectId, matchedFields };
  }
  return { status: "insufficient", matchedFields };
}
