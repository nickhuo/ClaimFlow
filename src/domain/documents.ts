import type { CaseFacts, CaseType } from "./claims.ts";
import type { Intent } from "./conversation.ts";
import type { DataFact } from "./facts.ts";

export const DOCUMENT_TYPES = ["pathology_report", "office_note", "accident_scene_photos", "repair_estimate"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const FOLLOWUP_TOPICS = [
  "missing_required_material_alternatives", "submission_timing", "processing_time_after_submission",
  "submission_method", "file_format_requirements", "receipt_confirmation",
] as const;

export interface FollowupGuidance {
  readonly topic: (typeof FOLLOWUP_TOPICS)[number];
  readonly intentHints: readonly Intent[];
  readonly requiresDocuments: boolean;
  readonly matchAny: readonly string[];
  readonly template: string;
}

export interface FollowupRule extends Omit<FollowupGuidance, "template"> {
  readonly template: string | null;
  readonly limitation: "unanchored_relative_deadline" | null;
}

export interface DocumentGuidance {
  readonly requestedName: string;
  readonly documentType: DocumentType | null;
  readonly mapping: "mapped" | "unmapped" | "unavailable";
  readonly guidelineKey: string | null;
  readonly originalRequirement: "required" | "not_specified";
  readonly guidance: DataFact<string> | null;
  readonly alternatives: DataFact<string>;
  readonly alternativesKind: "document_specific" | "general";
}

export interface CaseDocumentGuidance {
  readonly caseId: string;
  readonly documents: readonly DocumentGuidance[] | null;
  readonly general: DataFact<string>;
  readonly caseType: DataFact<string> | null;
  readonly processingTimeEstimate: DataFact<string>;
  readonly humanReview: DataFact<string>;
  readonly followupRules: readonly DataFact<FollowupRule>[];
  readonly fallback: DataFact<string>;
}

/** Source-independent, attributed guidance available to the insurance domain. */
export interface GuidanceCatalog {
  readonly general: DataFact<string>;
  readonly caseTypes: ReadonlyMap<CaseType, DataFact<string>>;
  readonly documents: ReadonlyMap<DocumentType, {
    readonly referenceKey: string;
    readonly guidance: DataFact<string>;
    readonly alternatives: DataFact<string> | null;
  }>;
  readonly generalAlternatives: DataFact<string>;
  readonly processingTimeEstimate: DataFact<string>;
  readonly humanReview: DataFact<string>;
  readonly followupGuidance: readonly DataFact<FollowupGuidance>[];
  readonly fallback: DataFact<string>;
}

/** Material equivalence is an insurance rule, independent of fixture/provider spelling. */
const DOCUMENT_NAMES: ReadonlyMap<string, DocumentType> = new Map([
  ["pathology report", "pathology_report"],
  ["original pathology report", "pathology_report"],
  ["office note", "office_note"],
  ["treating provider office note", "office_note"],
  ["supplemental accident scene photos", "accident_scene_photos"],
  ["repair estimate", "repair_estimate"],
]);

export function buildDocumentGuidance(
  caseFacts: Pick<CaseFacts, "caseId" | "caseType" | "documentsNeeded">,
  catalog: GuidanceCatalog,
): CaseDocumentGuidance {
  const documents = caseFacts.documentsNeeded?.map((requestedName): DocumentGuidance => {
    const type = DOCUMENT_NAMES.get(requestedName);
    const entry = type === undefined ? undefined : catalog.documents.get(type);
    return {
      requestedName,
      documentType: type ?? null,
      mapping: type === undefined ? "unmapped" : entry ? "mapped" : "unavailable",
      guidelineKey: entry?.referenceKey ?? null,
      originalRequirement: requestedName.startsWith("original ") ? "required" : "not_specified",
      guidance: entry?.guidance ?? null,
      alternatives: entry?.alternatives ?? catalog.generalAlternatives,
      alternativesKind: entry?.alternatives ? "document_specific" : "general",
    };
  }) ?? null;
  const followupRules = catalog.followupGuidance.map((fact): DataFact<FollowupRule> => {
    const unanchored = fact.value.topic === "submission_timing";
    return {
      ...fact,
      value: {
        ...fact.value,
        template: unanchored ? null : fact.value.template,
        limitation: unanchored ? "unanchored_relative_deadline" : null,
      },
    };
  });
  return structuredClone({
    caseId: caseFacts.caseId, documents, general: catalog.general,
    caseType: catalog.caseTypes.get(caseFacts.caseType) ?? null,
    processingTimeEstimate: catalog.processingTimeEstimate, humanReview: catalog.humanReview,
    followupRules, fallback: catalog.fallback,
  });
}
