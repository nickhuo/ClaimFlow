import type { RepresentativeRelationship } from "../domain/authorization.ts";
import type { AmountDefinition, AmountField, CaseFacts } from "../domain/claims.ts";
import type { CaseDocumentGuidance } from "../domain/documents.ts";
import type { DataFact } from "../domain/facts.ts";
import type { Policyholder } from "../domain/identity.ts";

export interface Clock {
  now(): number;
}

/** Simulation input, not a domain authorization grant. */
export interface ConsentScenario {
  readonly simulation: "mock";
  readonly statusSequence: readonly ("pending" | "approved" | "denied")[];
}

/** Server-only data needs; the caller supplies a subject from trusted session state. */
export interface BusinessData {
  getPolicyholder(subjectId: string): Promise<DataFact<Policyholder> | null>;
  findPolicyholderByPolicyNumber(policyNumber: string): Promise<DataFact<Policyholder> | null>;
  getRepresentatives(subjectId: string): Promise<readonly DataFact<RepresentativeRelationship>[]>;
  getConsentScenario(name: string): Promise<DataFact<ConsentScenario> | null>;
  listCases(subjectId: string): Promise<readonly DataFact<CaseFacts>[]>;
  getCase(subjectId: string, caseId: string): Promise<DataFact<CaseFacts> | null>;
  getDocumentGuidance(subjectId: string, caseId: string): Promise<DataFact<CaseDocumentGuidance> | null>;
  getAmountDefinition(field: AmountField): Promise<DataFact<AmountDefinition>>;
}
