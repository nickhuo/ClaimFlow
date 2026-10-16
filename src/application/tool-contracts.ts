import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { IDENTITY_FIELDS } from "../domain/identity.ts";
import { CASE_TYPES } from "../domain/claims.ts";
import { HANDOFF_REASONS, INTENTS, type Phase, type SopState } from "../domain/conversation.ts";

export type { BusinessData, Clock } from "./ports.ts";

/** Supplied by the server closure, never accepted from model tool arguments. */
export interface BusinessToolContext {
  readonly sessionId: string;
  readonly requestId: string;
  readonly stateVersion: number;
  readonly state: SopState;
  readonly now: number;
}

const text = Type.String({ minLength: 1 });
const integer = Type.Integer({ minimum: 0 });
const timestamp = Type.Integer();
const object = <Properties extends TProperties>(properties: Properties) =>
  Type.Object(properties, { additionalProperties: false });
const identityField = Type.Enum(IDENTITY_FIELDS);
const matchedFields = Type.Array(identityField, { uniqueItems: true });
const caseType = Type.Enum(CASE_TYPES);
const nullableText = Type.Union([text, Type.Null()]);
const decimal = Type.String({ pattern: "^-?\\d+\\.\\d{2}$" });
const callerFacts = object({
  role: Type.Optional(Type.Union([Type.Literal("policyholder"), Type.Literal("representative")])),
  identity: Type.Optional(
    object({
      fullName: Type.Optional(text),
      dateOfBirth: Type.Optional(text),
      phone: Type.Optional(text),
      email: Type.Optional(text),
      ssnLast4: Type.Optional(text),
    }),
  ),
  policyNumber: Type.Optional(text),
  representedPolicyNumber: Type.Optional(text),
  scope: Type.Optional(Type.Enum(["in_scope", "out_of_scope", "mixed", "unclear"])),
  emotion: Type.Optional(Type.Enum(["calm", "frustrated", "anxious", "confused", "refusing"])),
  topic: Type.Optional(
    Type.Enum([
      "status",
      "denial",
      "amounts",
      "documents",
      "alternatives",
      "deadline",
      "submission",
      "processing_time",
      "unknown",
    ]),
  ),
  intent: Type.Optional(Type.Enum(INTENTS)),
  caseHints: Type.Optional(
    object({
      caseId: Type.Optional(text),
      caseType: Type.Optional(caseType),
      month: Type.Optional(text),
      claimedStatus: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Unverified status the caller mentions, such as denied. A query hint, never proof of claim status.",
        }),
      ),
    }),
  ),
});
const caseReference = { caseId: text, subjectId: text };
const toolFact = <Value extends TSchema>(value: Value) =>
  object({
    origin: Type.Literal("tool"),
    toolName: text,
    operationId: text,
    observedAt: timestamp,
    sources: Type.Array(object({ adapter: text, resource: text, pointer: Type.String() }), {
      minItems: 1,
    }),
    value,
  });
const identityAssessment = Type.Union([
  object({ status: Type.Literal("insufficient"), matchedFields }),
  object({
    status: Type.Literal("conflict"),
    matchedFields,
    conflictingFields: matchedFields,
    reason: Type.Union([
      Type.Literal("field_mismatch"),
      Type.Literal("subject_mismatch"),
      Type.Literal("invalid_evidence"),
    ]),
  }),
  object({ status: Type.Literal("verified"), subjectId: text, matchedFields }),
]);
const authorization = Type.Union([
  object({ status: Type.Literal("not_required") }),
  object({ status: Type.Literal("pending"), requestedAt: timestamp }),
  object({ status: Type.Union([Type.Literal("denied"), Type.Literal("expired")]) }),
  object({
    status: Type.Literal("approved"),
    subjectId: text,
    representativeId: text,
    grantId: text,
    scope: Type.Literal("claims:read"),
    expiresAt: timestamp,
    source: Type.Union([Type.Literal("mock"), Type.Literal("external")]),
  }),
]);
const emailConsent = Type.Union([
  object({
    status: Type.Union([
      Type.Literal("not_asked"),
      Type.Literal("awaiting_choice"),
      Type.Literal("declined"),
    ]),
  }),
  object({
    status: Type.Literal("granted"),
    recipient: text,
    summaryVersion: integer,
    confirmationTurnId: text,
  }),
]);

function freeze<Schema>(schema: Schema): Schema {
  if (schema !== null && typeof schema === "object") {
    for (const child of Object.values(schema)) freeze(child);
    Object.freeze(schema);
  }
  return schema;
}

/** One source for business names, TypeScript contracts and Pi input/output schemas. */
export const BUSINESS_TOOL_SCHEMAS = freeze({
  record_facts: {
    input: object({ turnId: text, facts: callerFacts }),
    output: object({ recorded: Type.Literal(true) }),
  },
  verify_identity: {
    input: object({ turnId: text }),
    output: identityAssessment,
  },
  request_authorization: {
    input: object({ turnId: text }),
    output: authorization,
  },
  resolve_case: {
    input: object({ turnId: text }),
    output: Type.Union([
      object({ status: Type.Literal("selected"), case: toolFact(object(caseReference)) }),
      object({ status: Type.Literal("needs_clarification"), question: text }),
    ]),
  },
  read_case: {
    input: object({ caseId: text }),
    output: toolFact(
      object({
        ...caseReference,
        caseType,
        createdAt: text,
        status: text,
        summary: text,
        denialReason: nullableText,
        documentsNeeded: Type.Union([Type.Array(text), Type.Null()]),
        appealDeadline: nullableText,
        appealDeadlineStatus: Type.Union([
          Type.Literal("not_provided"),
          Type.Literal("past"),
          Type.Literal("today"),
          Type.Literal("future"),
        ]),
        amounts: object({
          expected_reimbursement_amount: Type.Optional(decimal),
          allowed_max_amount: Type.Optional(decimal),
          net_pay: Type.Optional(decimal),
          net_fee: Type.Optional(decimal),
        }),
      }),
    ),
  },
  document_guidance: {
    input: object({ caseId: text, question: text }),
    output: toolFact(object({ guidance: text })),
  },
  complete_case: {
    input: object({ confirmationTurnId: text }),
    output: object({ phase: Type.Literal("POST_PROCESS") }),
  },
  set_email_consent: {
    input: object({
      decision: Type.Union([Type.Literal("send"), Type.Literal("skip")]),
      confirmationTurnId: text,
      summaryVersion: integer,
    }),
    output: emailConsent,
  },
  send_summary: {
    input: object({ summaryVersion: integer }),
    output: object({
      status: Type.Union([
        Type.Literal("mock_recorded"),
        Type.Literal("submitted"),
        Type.Literal("failed"),
        Type.Literal("unknown"),
        Type.Literal("pending"),
      ]),
      deliveryId: text,
    }),
  },
  resume_case: {
    input: object({ turnId: text }),
    output: object({ phase: Type.Literal("PROCESS_CASE") }),
  },
  handoff: {
    input: object({ reason: Type.Enum(HANDOFF_REASONS) }),
    output: object({ status: Type.Literal("requested") }),
  },
} as const);

export type BusinessToolName = keyof typeof BUSINESS_TOOL_SCHEMAS;
type DeepReadonly<Value> = Value extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value;
export type BusinessToolContracts = {
  [Name in BusinessToolName]: {
    input: Static<(typeof BUSINESS_TOOL_SCHEMAS)[Name]["input"]>;
    output: DeepReadonly<Static<(typeof BUSINESS_TOOL_SCHEMAS)[Name]["output"]>>;
  };
};

export interface BusinessToolHandler<Name extends BusinessToolName> {
  execute(
    input: BusinessToolContracts[Name]["input"],
    context: BusinessToolContext,
    signal?: AbortSignal,
  ): Promise<BusinessToolContracts[Name]["output"]>;
}

export const BUSINESS_TOOL_NAMES: readonly BusinessToolName[] = Object.freeze(
  Object.keys(BUSINESS_TOOL_SCHEMAS) as BusinessToolName[],
);

/** Exposure policy only: implementations must also check current identity and ownership. */
export const PHASE_TOOLS = {
  VERIFY_ID: ["record_facts", "verify_identity", "request_authorization", "handoff"],
  RESOLVE_INTENT: ["record_facts", "resolve_case", "handoff"],
  PROCESS_CASE: [
    "record_facts",
    "verify_identity",
    "resolve_case",
    "read_case",
    "document_guidance",
    "complete_case",
    "handoff",
  ],
  POST_PROCESS: ["record_facts", "set_email_consent", "send_summary", "resume_case", "handoff"],
} as const satisfies Record<Phase, readonly BusinessToolName[]>;
