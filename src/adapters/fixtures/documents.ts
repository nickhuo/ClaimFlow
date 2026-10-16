import { CASE_TYPES, type CaseFacts } from "../../domain/claims.ts";
import {
  buildDocumentGuidance,
  DOCUMENT_TYPES,
  type DocumentType,
  type CaseDocumentGuidance,
  type FollowupGuidance,
  type GuidanceCatalog,
} from "../../domain/documents.ts";
import type { DataFact } from "../../domain/facts.ts";
import { fact, pointerKey, source, type FixtureRecords } from "./schema.ts";

const GUIDELINE_KEYS = {
  pathology_report: "original pathology report",
  office_note: "treating provider office note",
  accident_scene_photos: "supplemental accident scene photos",
  repair_estimate: "repair estimate",
} as const satisfies Record<DocumentType, string>;

/** Translate fixture spelling and source locations; the domain interprets requirements. */
export function documentGuidance(
  guidelines: FixtureRecords["required_document_guideline.json"],
  caseFacts: CaseFacts,
  claimIndex: number,
  observedAt: number,
): DataFact<CaseDocumentGuidance> {
  const file = "required_document_guideline.json";
  const textFact = (pointer: string, value: string) =>
    fact(file, `${pointer}/en`, value, observedAt);
  const catalog: GuidanceCatalog = {
    general: textFact("/default_guidance", guidelines.default_guidance.en),
    caseTypes: new Map(
      CASE_TYPES.flatMap((type) => {
        const entry = Object.hasOwn(guidelines.case_type_guidance, type)
          ? guidelines.case_type_guidance[type]
          : undefined;
        return entry ? [[type, textFact(`/case_type_guidance/${type}`, entry.en)]] : [];
      }),
    ),
    documents: new Map(
      DOCUMENT_TYPES.flatMap((type) => {
        const key = GUIDELINE_KEYS[type];
        const value = Object.hasOwn(guidelines.document_guidance, key)
          ? guidelines.document_guidance[key]
          : undefined;
        if (!value) return [];
        const alternative = Object.hasOwn(guidelines.document_alternative_guidance, key)
          ? guidelines.document_alternative_guidance[key]
          : undefined;
        return [
          [
            type,
            {
              referenceKey: key,
              guidance: textFact(`/document_guidance/${pointerKey(key)}`, value.en),
              alternatives: alternative
                ? textFact(`/document_alternative_guidance/${pointerKey(key)}`, alternative.en)
                : null,
            },
          ],
        ];
      }),
    ),
    generalAlternatives: textFact(
      "/document_alternative_guidance/default",
      guidelines.document_alternative_guidance.default.en,
    ),
    processingTimeEstimate: textFact(
      "/claim_followup_settings/average_processing_time_after_submission",
      guidelines.claim_followup_settings.average_processing_time_after_submission.en,
    ),
    humanReview: textFact(
      "/claim_followup_settings/human_review_after_document_alternatives_exhausted",
      guidelines.claim_followup_settings.human_review_after_document_alternatives_exhausted.en,
    ),
    followupGuidance: guidelines.claim_followup_guidance.map((rule, index) =>
      fact<FollowupGuidance>(
        file,
        `/claim_followup_guidance/${index}`,
        {
          topic: rule.topic,
          intentHints: rule.intent_hints,
          requiresDocuments: rule.requires_documents,
          matchAny: rule.match_any ?? [],
          template: rule.en,
        },
        observedAt,
      ),
    ),
    fallback: textFact("/claim_followup_fallback", guidelines.claim_followup_fallback.en),
  };
  return {
    sources: [source("claims.json", `/${claimIndex}`), source(file, "")],
    observedAt,
    value: buildDocumentGuidance(caseFacts, catalog),
  };
}
