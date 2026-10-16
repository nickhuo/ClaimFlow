import { describe, expect, test } from "bun:test";
import { buildDocumentGuidance, type GuidanceCatalog } from "../../src/domain/documents.ts";
import type { DataFact } from "../../src/domain/facts.ts";

function attributed<Value>(value: Value): DataFact<Value> {
  return { sources: [{ adapter: "reference", resource: "guidance", pointer: "" }], observedAt: 0, value };
}
function catalog(): GuidanceCatalog {
  return {
    general: attributed("Prepare readable documents"), caseTypes: new Map(),
    documents: new Map([
      ["pathology_report", { referenceKey: "PATH-REFERENCE", guidance: attributed("A readable report"), alternatives: attributed("Ask the lab for a copy") }],
      ["office_note", { referenceKey: "OFFICE-REFERENCE", guidance: attributed("A complete office note"), alternatives: null }],
    ]),
    generalAlternatives: attributed("Ask the record source for a replacement"),
    processingTimeEstimate: attributed("Usually less than a week"),
    humanReview: attributed("Ask for human review when alternatives are exhausted"),
    followupGuidance: [attributed({
      topic: "submission_timing", intentHints: ["document_submission"], requiresDocuments: true,
      matchAny: ["when"], template: "Submit within a week",
    })],
    fallback: attributed("No separate rule"),
  };
}
const caseFacts = { caseId: "case-1", caseType: "healthcare" as const, documentsNeeded: ["pathology report", "office note"] };

describe("Document guidance", () => {
  test("material equivalence does not add an original requirement", () => {
    const result = buildDocumentGuidance(caseFacts, catalog());
    expect(result.documents?.[0]).toMatchObject({
      requestedName: "pathology report", documentType: "pathology_report", guidelineKey: "PATH-REFERENCE", mapping: "mapped",
      originalRequirement: "not_specified", alternativesKind: "document_specific",
    });
    expect(result.documents?.[1]).toMatchObject({ documentType: "office_note", guidelineKey: "OFFICE-REFERENCE", alternativesKind: "general" });
  });

  test("unknown clinical records are not substituted and explicit originals remain required", () => {
    const result = buildDocumentGuidance({ ...caseFacts, documentsNeeded: ["diagnosis report", "original diagnosis report"] }, catalog());
    expect(result.documents?.[0]).toMatchObject({ mapping: "unmapped", guidance: null, originalRequirement: "not_specified", alternativesKind: "general" });
    expect(result.documents?.[1]).toMatchObject({ mapping: "unmapped", originalRequirement: "required" });
  });

  test("missing guides and absent requirements do not invent instructions", () => {
    const reference = catalog();
    const missing = { ...reference, documents: new Map() };
    expect(buildDocumentGuidance(caseFacts, missing).documents?.[0]).toMatchObject({ mapping: "unavailable", guidance: null });
    expect(buildDocumentGuidance({ ...caseFacts, documentsNeeded: null }, reference).documents).toBeNull();
    expect(buildDocumentGuidance({ ...caseFacts, documentsNeeded: [] }, reference).documents).toEqual([]);
  });

  test("unanchored relative deadlines are withheld independently of the source", () => {
    const reference = catalog();
    const result = buildDocumentGuidance(caseFacts, reference);
    expect(result.followupRules[0]?.value).toMatchObject({ template: null, limitation: "unanchored_relative_deadline" });
    expect(result.followupRules[0]?.sources[0]?.adapter).toBe("reference");
    expect(reference.followupGuidance[0]?.value.template).toBe("Submit within a week");
  });
});
