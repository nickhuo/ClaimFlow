import type { IdentityField, ToolFact, UserStatement } from "../src/sop/types.ts";
import type { BusinessToolContracts, BusinessToolName } from "../src/tools/contracts.ts";

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
    [Name in BusinessToolName]: Extract<keyof BusinessToolContracts[Name]["input"], "state" | "sessionId" | "stateVersion">
  }[BusinessToolName] extends never
    ? true : false
>;
