import { defineBusinessTool } from "../src/adapters/pi/tools.ts";
import type { CallerFacts, EmailConsent } from "../src/domain/conversation.ts";
import type { CaseFacts } from "../src/domain/claims.ts";
import type { IdentityAssessment, IdentityField } from "../src/domain/identity.ts";
import type { RepresentativeAuthorization } from "../src/domain/authorization.ts";
import type { ToolFact, UserStatement } from "../src/domain/facts.ts";
import type { BusinessToolContracts, BusinessToolName } from "../src/application/tool-contracts.ts";

type Assert<Condition extends true> = Condition;

export type UserStatementsAreNotToolFacts = Assert<
  UserStatement<string> extends ToolFact<string> ? false : true
>;
export type PolicyNumbersAreNotIdentityEvidence = Assert<
  "policyNumber" extends IdentityField ? false : true
>;
export type EveryBusinessToolHasTypedInputAndOutput = Assert<
  BusinessToolContracts[BusinessToolName] extends { input: unknown; output: unknown } ? true : false
>;
export type ToolInputsDoNotSupplyTrustedContext = Assert<
  {
    [Name in BusinessToolName]: Extract<
      keyof BusinessToolContracts[Name]["input"],
      "state" | "sessionId" | "stateVersion"
    >;
  }[BusinessToolName] extends never
    ? true
    : false
>;

// Canonical runtime schemas must keep the existing domain contract in both directions.
type SameShape<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
export type CallerFactsContract = Assert<
  SameShape<BusinessToolContracts["record_facts"]["input"]["facts"], CallerFacts>
>;
export type CaseFactsContract = Assert<
  SameShape<BusinessToolContracts["read_case"]["output"], ToolFact<CaseFacts>>
>;
export type IdentityContract = Assert<
  SameShape<BusinessToolContracts["verify_identity"]["output"], IdentityAssessment>
>;
export type AuthorizationContract = Assert<
  SameShape<BusinessToolContracts["request_authorization"]["output"], RepresentativeAuthorization>
>;
export type EmailConsentContract = Assert<
  SameShape<BusinessToolContracts["set_email_consent"]["output"], EmailConsent>
>;

// These are never executed. An unused @ts-expect-error fails the typecheck if drift returns.
export function rejectWrongInput() {
  defineBusinessTool({
    name: "read_case",
    label: "Invalid",
    description: "Mismatched input",
    // @ts-expect-error read_case requires caseId; callbacks cannot widen the name to another tool.
    authorize: (_input: { unrelated: number }) => {},
    async execute() {
      throw new Error("Not executed");
    },
  });
}

export function rejectWrongOutput() {
  defineBusinessTool({
    name: "read_case",
    label: "Invalid",
    description: "Mismatched output",
    authorize: () => {},
    // @ts-expect-error read_case must return a sourced case fact, not arbitrary details.
    execute: async () => ({ unrelated: true }),
  });
}

export function rejectSchemaOverride() {
  defineBusinessTool({
    name: "record_facts",
    label: "Invalid",
    description: "Schema override",
    authorize: () => {},
    async execute() {
      return { recorded: true };
    },
    // @ts-expect-error input schemas come from the name's canonical business contract.
    parameters: { type: "object", properties: {} },
  });
}
