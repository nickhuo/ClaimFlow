import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { Case, CaseInvariantError, AMOUNT_FIELDS, CASE_TYPES } from "../../domain/claims.ts";
import { isCalendarDate } from "../../domain/calendar.ts";
import { INTENTS } from "../../domain/conversation.ts";
import { FOLLOWUP_TOPICS } from "../../domain/documents.ts";
import type { DataFact, FactSource } from "../../domain/facts.ts";

const text = Type.String({ pattern: "\\S" });
const date = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const decimal = Type.String({ pattern: "^-?\\d+\\.\\d{2}$" });
const texts = Type.Array(text);
const localized = Type.Object({ en: text }, { additionalProperties: false });
const optionalText = Type.Optional(Type.Union([text, Type.Null()]));
const caseType = Type.Enum(CASE_TYPES);
const intent = Type.Enum(INTENTS);

const policyholders = Type.Array(Type.Object({
  party_id: text,
  name: text,
  name_aliases: Type.Optional(texts),
  policy_number: text,
  dob: date,
  id_type: Type.Union([Type.Literal("ssn_last4"), Type.Literal("national_id_last4")]),
  id_last4: Type.String({ pattern: "^\\d{4}$" }),
  phone: text,
  phone_aliases: Type.Optional(texts),
  email: text,
  email_aliases: Type.Optional(texts),
}, { additionalProperties: false }));

const claims = Type.Array(Type.Object({
  case_id: text,
  party_id: text,
  case_type: caseType,
  created_at: date,
  status: text,
  summary: text,
  denial_reason: optionalText,
  documents_needed: Type.Optional(Type.Union([texts, Type.Null()])),
  appeal_deadline: Type.Optional(Type.Union([date, Type.Null()])),
  expected_reimbursement_amount: Type.Optional(decimal),
  allowed_max_amount: Type.Optional(decimal),
  net_pay: Type.Optional(decimal),
  net_fee: Type.Optional(decimal),
}, { additionalProperties: false }));

const representatives = Type.Array(Type.Object({
  rep_name: text,
  relationship: text,
  buyer_name: text,
  buyer_party_id: text,
}, { additionalProperties: false }));

const consentScenarios = Type.Record(text, Type.Object({
  status_sequence: Type.Array(Type.Union([
    Type.Literal("pending"), Type.Literal("approved"), Type.Literal("denied"),
  ]), { minItems: 1 }),
}, { additionalProperties: false }));

const amountDefinition = Type.Object({
  type: Type.Literal("string"), example: decimal, description: text,
}, { additionalProperties: false });

const claimSchema = Type.Object({
  notes: texts,
  field_descriptions: Type.Object({
    expected_reimbursement_amount: amountDefinition,
    allowed_max_amount: amountDefinition,
    net_pay: amountDefinition,
    net_fee: amountDefinition,
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const guidelines = Type.Object({
  default_guidance: localized,
  case_type_guidance: Type.Record(text, localized),
  document_guidance: Type.Record(text, localized),
  document_alternative_guidance: Type.Intersect([
    Type.Record(text, localized), Type.Object({ default: localized }),
  ]),
  claim_followup_settings: Type.Object({
    average_processing_time_after_submission: localized,
    human_review_after_document_alternatives_exhausted: localized,
  }, { additionalProperties: false }),
  claim_followup_guidance: Type.Array(Type.Object({
    topic: Type.Enum(FOLLOWUP_TOPICS),
    intent_hints: Type.Array(intent),
    requires_documents: Type.Boolean(),
    match_any: Type.Optional(texts),
    en: text,
  }, { additionalProperties: false })),
  claim_followup_fallback: localized,
}, { additionalProperties: false });

export const FIXTURE_SCHEMAS = {
  "policyholders.json": policyholders,
  "claims.json": claims,
  "representatives.json": representatives,
  "consent_scenarios.json": consentScenarios,
  "claim_schema.json": claimSchema,
  "required_document_guideline.json": guidelines,
} as const;

export type FixtureFile = keyof typeof FIXTURE_SCHEMAS;
export type FixtureInput = { readonly [File in FixtureFile]: unknown };
export type FixtureRecords = { [File in FixtureFile]: Static<(typeof FIXTURE_SCHEMAS)[File]> };

export function pointerKey(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function source(file: FixtureFile, pointer: string): FactSource {
  return { adapter: "fixtures", resource: file, pointer };
}

export function fact<Value>(file: FixtureFile, pointer: string, value: Value, observedAt: number): DataFact<Value> {
  return structuredClone({ sources: [source(file, pointer)], observedAt, value });
}

type ErrorCode = "read_failed" | "invalid_json" | "invalid_structure" | "invalid_date"
  | "duplicate_id" | "unknown_subject" | "inconsistent_reference" | "missing_guideline";

/** Paths and codes are safe to log; rejected values and parser messages may contain PII. */
export class FixtureDataError extends Error {
  constructor(
    readonly file: FixtureFile,
    readonly pointer: string,
    readonly code: ErrorCode,
  ) {
    super(`${file}#${pointer}: ${code}`);
    this.name = "FixtureDataError";
  }
}

function validate<Schema extends TSchema>(file: FixtureFile, schema: Schema, input: unknown): Static<Schema> {
  if (!Check(schema, input)) {
    throw new FixtureDataError(file, Errors(schema, input)[0]?.instancePath ?? "", "invalid_structure");
  }
  return input;
}

function parseFixtures(input: FixtureInput): FixtureRecords {
  // Snapshot first: later mutations of test/host input must not change validated data.
  const snapshot = structuredClone(input);
  return {
    "policyholders.json": validate("policyholders.json", policyholders, snapshot["policyholders.json"]),
    "claims.json": validate("claims.json", claims, snapshot["claims.json"]),
    "representatives.json": validate("representatives.json", representatives, snapshot["representatives.json"]),
    "consent_scenarios.json": validate("consent_scenarios.json", consentScenarios, snapshot["consent_scenarios.json"]),
    "claim_schema.json": validate("claim_schema.json", claimSchema, snapshot["claim_schema.json"]),
    "required_document_guideline.json": validate("required_document_guideline.json", guidelines, snapshot["required_document_guideline.json"]),
  };
}

interface Located<T> {
  readonly record: T;
  readonly index: number;
}

function indexRecords<T>(file: FixtureFile, records: readonly T[], key: keyof T): Map<string, Located<T>> {
  const index = new Map<string, Located<T>>();
  records.forEach((record, position) => {
    const id = String(record[key]);
    if (index.has(id)) throw new FixtureDataError(file, `/${position}/${String(key)}`, "duplicate_id");
    index.set(id, { record, index: position });
  });
  return index;
}

/** The only preparation entry: snapshot, structure, calendar, references and indexes. */
export function prepareFixtures(input: FixtureInput) {
  const records = parseFixtures(input);
  const holders = indexRecords("policyholders.json", records["policyholders.json"], "party_id");
  const policies = indexRecords("policyholders.json", records["policyholders.json"], "policy_number");
  const rawCases = indexRecords("claims.json", records["claims.json"], "case_id");
  const cases = new Map<string, Located<Case>>();

  for (const { record, index } of holders.values()) {
    if (!isCalendarDate(record.dob)) throw new FixtureDataError("policyholders.json", `/${index}/dob`, "invalid_date");
  }
  for (const { record, index } of rawCases.values()) {
    if (!holders.has(record.party_id)) throw new FixtureDataError("claims.json", `/${index}/party_id`, "unknown_subject");
    const amounts = Object.fromEntries(AMOUNT_FIELDS.flatMap((field) => record[field] === undefined ? [] : [[field, record[field]]]));
    try {
      cases.set(record.case_id, { index, record: new Case({
        caseId: record.case_id, subjectId: record.party_id, caseType: record.case_type,
        createdAt: record.created_at, status: record.status, summary: record.summary,
        denialReason: record.denial_reason ?? null, documentsNeeded: record.documents_needed ?? null,
        appealDeadline: record.appeal_deadline ?? null, amounts,
      }) });
    } catch (error) {
      if (!(error instanceof CaseInvariantError)) throw error;
      const field = error.field === "createdAt" ? "created_at" : error.field === "appealDeadline" ? "appeal_deadline" : "";
      const code = error.reason === "invalid_date" ? "invalid_date"
        : error.reason === "deadline_before_creation" ? "inconsistent_reference" : "invalid_structure";
      throw new FixtureDataError("claims.json", `/${index}${field ? `/${field}` : ""}`, code);
    }
  }
  records["representatives.json"].forEach((record, index) => {
    const holder = holders.get(record.buyer_party_id)?.record;
    if (!holder) throw new FixtureDataError("representatives.json", `/${index}/buyer_party_id`, "unknown_subject");
    if (![holder.name, ...(holder.name_aliases ?? [])].includes(record.buyer_name)) {
      throw new FixtureDataError("representatives.json", `/${index}/buyer_name`, "inconsistent_reference");
    }
  });
  const guidelines = records["required_document_guideline.json"];
  for (const key of Object.keys(guidelines.document_alternative_guidance)) {
    if (key !== "default" && !Object.hasOwn(guidelines.document_guidance, key)) {
      throw new FixtureDataError("required_document_guideline.json", `/document_alternative_guidance/${pointerKey(key)}`, "missing_guideline");
    }
  }
  return { records, holders, policies, cases };
}
