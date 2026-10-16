import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFixtureData,
  FixtureDataError,
  loadFixtureData,
} from "../src/adapters/fixtures/index.ts";
import {
  FIXTURE_SCHEMAS,
  type FixtureInput,
  type FixtureRecords,
} from "../src/adapters/fixtures/schema.ts";

const clock = { now: () => Date.parse("2026-10-15T12:00:00.000Z") };
const fileNames = Object.keys(FIXTURE_SCHEMAS) as (keyof FixtureInput)[];
const realInput = Object.fromEntries(
  await Promise.all(
    fileNames.map(async (file) => [
      file,
      await Bun.file(new URL(`../fixtures/${file}`, import.meta.url)).json(),
    ]),
  ),
) as FixtureRecords;

function input(): FixtureRecords {
  return structuredClone(realInput);
}

function firstClaim() {
  return { ...realInput["claims.json"][0]! };
}

function expectInvalid(sample: FixtureInput, file: string, code: string) {
  let caught: unknown;
  try {
    createFixtureData(sample, { clock });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(FixtureDataError);
  expect(caught).toMatchObject({ file, code });
  return caught as FixtureDataError;
}

describe("fixture business data", () => {
  test("loads all six real files and returns only the subject's sourced cases", async () => {
    const data = await loadFixtureData({ clock });
    const cases = await data.listCases("P9");
    expect(cases.map(({ value }) => value.caseId)).toEqual([
      "CL-2048",
      "CL-2011",
      "CL-1899",
      "CL-2102",
    ]);
    expect(cases.every(({ value }) => value.subjectId === "P9")).toBe(true);
    expect(cases[0]).toMatchObject({
      sources: [{ adapter: "fixtures", resource: "claims.json", pointer: "/0" }],
      observedAt: clock.now(),
      value: {
        createdAt: "2026-01-12",
        appealDeadline: "2026-03-18",
        appealDeadlineStatus: "past",
        denialReason:
          "the review file did not include the pathology report and the treating provider office note",
        amounts: {
          expected_reimbursement_amount: "0.00",
          allowed_max_amount: "1450.00",
          net_pay: "0.00",
          net_fee: "1450.00",
        },
      },
    });
    expect(cases[2]?.value.caseType).toBe("dental");
    expect((await data.listCases("P12")).map(({ value }) => value.caseId)).toEqual(["CL-3001"]);
    expect(await data.getCase("P9", "CL-3001")).toBeNull();
    expect(await data.getDocumentGuidance("P9", "CL-3001")).toBeNull();
    expect(await data.getCase("P12", "CL-2048")).toBeNull();
    expect(await data.getCase("P9", "missing")).toBeNull();
    expect(await data.listCases("missing")).toEqual([]);
  });

  test("preserves identifiers and aliases without treating national ID as SSN", async () => {
    const data = createFixtureData(input(), { clock });
    expect(await data.findPolicyholderByPolicyNumber("POL-9921")).toMatchObject({
      sources: [{ resource: "policyholders.json", pointer: "/0" }],
      value: { subjectId: "P9", identifier: { type: "ssn_last4", last4: "4472" } },
    });
    expect((await data.getPolicyholder("P13"))?.value).toMatchObject({
      nameAliases: ["Yaven Li"],
      emailAliases: ["yawen.li@example.com"],
      phoneAliases: ["+16505212830"],
      identifier: { type: "national_id_last4", last4: "5317" },
    });
    expect((await data.getPolicyholder("P12"))?.value.identifier.type).toBe("national_id_last4");
    expect(await data.findPolicyholderByPolicyNumber("missing")).toBeNull();
    expect(await data.getPolicyholder("missing")).toBeNull();
    const representatives = await data.getRepresentatives("P9");
    expect(representatives[0]).toMatchObject({
      sources: [{ resource: "representatives.json", pointer: "/0" }],
      value: { subjectId: "P9", fullName: "David Chen", relationship: "son" },
    });
    expect(representatives[0]?.value).not.toHaveProperty("status");
    expect(await data.getRepresentatives("P12")).toEqual([]);
  });

  test("returns only the named, explicitly mock consent sequence without granting permissions", async () => {
    const data = createFixtureData(input(), { clock });
    expect(await data.getConsentScenario("default")).toMatchObject({
      sources: [{ resource: "consent_scenarios.json", pointer: "/default" }],
      value: { simulation: "mock", statusSequence: ["pending", "approved"] },
    });
    expect((await data.getConsentScenario("timeout"))?.value.statusSequence).toEqual(
      Array(5).fill("pending"),
    );
    expect(await data.getConsentScenario("missing")).toBeNull();
    expect(await data.getConsentScenario("toString")).toBeNull();
    expect(await data.getConsentScenario("__proto__")).toBeNull();
  });

  test("keeps decimal strings exact, never fills absent amounts from schema examples", async () => {
    const sample = input();
    sample["claims.json"] = [
      { ...firstClaim(), net_pay: "900719925474099312345.67", net_fee: "0000.00" },
    ];
    delete sample["claims.json"][0]!.allowed_max_amount;
    delete sample["claims.json"][0]!.expected_reimbursement_amount;
    const data = createFixtureData(sample, { clock });
    expect((await data.getCase("P9", "CL-2048"))?.value.amounts).toEqual({
      net_pay: "900719925474099312345.67",
      net_fee: "0000.00",
    });
    expect(await data.getAmountDefinition("net_pay")).toMatchObject({
      sources: [{ resource: "claim_schema.json", pointer: "/field_descriptions/net_pay" }],
      value: { currency: "USD", field: "net_pay", example: "780.00" },
    });
    expect((await data.getCase("P9", "CL-2048"))?.value.amounts).not.toHaveProperty(
      "allowed_max_amount",
    );
  });

  test("distinguishes missing document requirements from an explicitly empty list", async () => {
    const sample = input();
    sample["claims.json"] = [
      {
        case_id: "minimal",
        party_id: "P9",
        case_type: "auto",
        created_at: "2024-02-29",
        status: "open",
        summary: "Minimal record",
      },
    ];
    const data = createFixtureData(sample, { clock });
    expect((await data.getCase("P9", "minimal"))?.value).toMatchObject({
      denialReason: null,
      documentsNeeded: null,
      appealDeadline: null,
      appealDeadlineStatus: "not_provided",
      amounts: {},
    });
    expect((await data.getDocumentGuidance("P9", "minimal"))?.value.documents).toBeNull();
    sample["claims.json"][0]!.documents_needed = [];
    expect(
      (await createFixtureData(sample, { clock }).getCase("P9", "minimal"))?.value.documentsNeeded,
    ).toEqual([]);
    sample["claims.json"][0]!.documents_needed = null;
    expect(
      (await createFixtureData(sample, { clock }).getCase("P9", "minimal"))?.value.documentsNeeded,
    ).toBeNull();
  });

  test("deadline classification uses the injected clock at query time with UTC date boundaries", async () => {
    let time = Date.parse("2026-03-17T23:59:59.999Z");
    const data = createFixtureData(input(), { clock: { now: () => time } });
    expect((await data.getCase("P9", "CL-2048"))?.value.appealDeadlineStatus).toBe("future");
    time += 1;
    expect((await data.getCase("P9", "CL-2048"))?.value.appealDeadlineStatus).toBe("today");
    time = Date.parse("2026-03-19T00:00:00.000Z");
    const result = await data.getCase("P9", "CL-2048");
    expect(result?.value.appealDeadlineStatus).toBe("past");
    expect(result?.value.appealDeadline).toBe("2026-03-18");
    expect(result?.value.createdAt).toBe("2026-01-12");
    expect(result?.observedAt).toBe(time);
  });

  test("validated input and returned facts cannot mutate later reads", async () => {
    const sample = input();
    const data = createFixtureData(sample, { clock });
    sample["claims.json"][0]!.net_pay = "999.00";
    sample["policyholders.json"][0]!.name = "Changed";
    const returned = await data.getCase("P9", "CL-2048");
    (returned!.value.amounts as Record<string, string>).net_pay = "123.00";
    (returned!.value.documentsNeeded as string[]).push("invented item");
    expect((await data.getCase("P9", "CL-2048"))?.value.amounts.net_pay).toBe("0.00");
    expect((await data.getCase("P9", "CL-2048"))?.value.documentsNeeded).toEqual([
      "pathology report",
      "office note",
    ]);
    expect((await data.getPolicyholder("P9"))?.value.fullName).toBe("Margaret Chen");
  });
});

describe("document mapping", () => {
  test("aliases retain the requested names and do not upgrade to originals", async () => {
    const data = createFixtureData(input(), { clock });
    const guidance = (await data.getDocumentGuidance("P9", "CL-2048"))!.value;
    expect(guidance.documents?.[0]).toMatchObject({
      requestedName: "pathology report",
      mapping: "mapped",
      guidelineKey: "original pathology report",
      originalRequirement: "not_specified",
      alternativesKind: "document_specific",
      guidance: {
        sources: [
          {
            resource: "required_document_guideline.json",
            pointer: "/document_guidance/original pathology report/en",
          },
        ],
      },
    });
    expect(guidance.documents?.[1]).toMatchObject({
      requestedName: "office note",
      guidelineKey: "treating provider office note",
      originalRequirement: "not_specified",
    });
    const timing = guidance.followupRules.find(({ value }) => value.topic === "submission_timing");
    expect(timing?.value).toMatchObject({
      template: null,
      limitation: "unanchored_relative_deadline",
    });
    expect(JSON.stringify(guidance)).not.toContain("within a week");
    expect(guidance.processingTimeEstimate.value).toBe("usually less than a week");
    expect(
      guidance.followupRules.find(({ value }) => value.topic === "submission_method")?.value
        .template,
    ).toContain("{case_id}");
  });

  test("an explicitly requested original remains required and supported auto materials map exactly", async () => {
    const sample = input();
    sample["claims.json"][0]!.documents_needed = [
      "original pathology report",
      "treating provider office note",
      "supplemental accident scene photos",
      "repair estimate",
    ];
    const documents = (
      await createFixtureData(sample, { clock }).getDocumentGuidance("P9", "CL-2048")
    )?.value.documents;
    expect(documents?.[0]?.originalRequirement).toBe("required");
    expect(documents?.map((document) => document.mapping)).toEqual(Array(4).fill("mapped"));
  });

  test("unknown materials receive only labeled general guidance, never a guessed clinical equivalent", async () => {
    const data = createFixtureData(input(), { clock });
    const document = (await data.getDocumentGuidance("P12", "CL-3001"))?.value.documents?.[0];
    expect(document).toMatchObject({
      requestedName: "diagnosis report",
      mapping: "unmapped",
      guidelineKey: null,
      guidance: null,
      originalRequirement: "not_specified",
      alternativesKind: "general",
      alternatives: { sources: [{ pointer: "/document_alternative_guidance/default/en" }] },
    });
    expect(document?.alternatives.value).not.toContain("pathology");
    expect((await data.getDocumentGuidance("P9", "CL-1899"))?.value.caseType).toBeNull();
    const sample = input();
    sample["claims.json"][0]!.documents_needed = ["original diagnosis report"];
    const unknownOriginal = (
      await createFixtureData(sample, { clock }).getDocumentGuidance("P9", "CL-2048")
    )?.value.documents?.[0];
    expect(unknownOriginal).toMatchObject({
      mapping: "unmapped",
      guidance: null,
      originalRequirement: "required",
    });
  });

  test("a missing specific guideline is explicit and cannot silently become a material requirement", async () => {
    const sample = input();
    delete sample["required_document_guideline.json"].document_guidance[
      "original pathology report"
    ];
    delete sample["required_document_guideline.json"].document_alternative_guidance[
      "original pathology report"
    ];
    const document = (
      await createFixtureData(sample, { clock }).getDocumentGuidance("P9", "CL-2048")
    )?.value.documents?.[0];
    expect(document).toMatchObject({
      mapping: "unavailable",
      guidance: null,
      alternativesKind: "general",
      originalRequirement: "not_specified",
    });
  });
});

describe("invalid fixtures fail atomically", () => {
  test.each([
    ["required field", { summary: undefined }],
    ["numeric amount", { net_pay: 0 }],
    ["empty amount", { net_pay: "" }],
    ["exponent amount", { net_pay: "1e3" }],
    ["null amount", { net_pay: null }],
    ["invalid document list", { documents_needed: "office note" }],
    ["unknown field", { invented_amount: "1.00" }],
  ])("reject %s rather than manufacture defaults", (_name, invalid) => {
    expectInvalid(
      { ...input(), "claims.json": [{ ...firstClaim(), ...invalid }] },
      "claims.json",
      "invalid_structure",
    );
  });

  test.each(["2026-02-30", "2025-02-29", "2026-13-01"])(
    "reject impossible date %s without normalizing it",
    (invalid) => {
      expectInvalid(
        { ...input(), "claims.json": [{ ...firstClaim(), appeal_deadline: invalid }] },
        "claims.json",
        "invalid_date",
      );
    },
  );

  test("reject impossible identity dates, inconsistent timelines and unresolved references", () => {
    const sample = input();
    sample["policyholders.json"][0]!.dob = "1985-02-30";
    expectInvalid(sample, "policyholders.json", "invalid_date");
    expectInvalid(
      { ...input(), "claims.json": [{ ...firstClaim(), appeal_deadline: "2025-01-01" }] },
      "claims.json",
      "inconsistent_reference",
    );
    expectInvalid(
      { ...input(), "claims.json": [{ ...firstClaim(), party_id: "missing" }] },
      "claims.json",
      "unknown_subject",
    );
    expectInvalid(
      {
        ...input(),
        "representatives.json": [
          { ...realInput["representatives.json"][0]!, buyer_party_id: "missing" },
        ],
      },
      "representatives.json",
      "unknown_subject",
    );
    expectInvalid(
      {
        ...input(),
        "representatives.json": [
          { ...realInput["representatives.json"][0]!, buyer_name: "Someone else" },
        ],
      },
      "representatives.json",
      "inconsistent_reference",
    );
  });

  test("reject duplicate subject, policy and case identifiers", () => {
    const duplicate = input();
    duplicate["claims.json"].push(firstClaim());
    expectInvalid(duplicate, "claims.json", "duplicate_id");
    const subject = input();
    subject["policyholders.json"].push({ ...subject["policyholders.json"][0]! });
    expectInvalid(subject, "policyholders.json", "duplicate_id");
    const policy = input();
    policy["policyholders.json"][1]!.policy_number = policy["policyholders.json"][0]!.policy_number;
    expectInvalid(policy, "policyholders.json", "duplicate_id");
  });

  test("reject missing files/definitions, invalid guides and empty simulation sequences", () => {
    expectInvalid(
      { ...input(), "policyholders.json": undefined },
      "policyholders.json",
      "invalid_structure",
    );
    expectInvalid(
      { ...input(), "claim_schema.json": {} },
      "claim_schema.json",
      "invalid_structure",
    );
    expectInvalid(
      { ...input(), "consent_scenarios.json": { broken: { status_sequence: [] } } },
      "consent_scenarios.json",
      "invalid_structure",
    );
    const sample = input();
    sample["required_document_guideline.json"].default_guidance.en = "";
    expectInvalid(sample, "required_document_guideline.json", "invalid_structure");
    const orphan = input();
    orphan["required_document_guideline.json"].document_alternative_guidance.orphan = {
      en: "Unknown material",
    };
    expectInvalid(orphan, "required_document_guideline.json", "missing_guideline");
  });

  test("validation errors identify a safe source path without logging PII or rejected values", () => {
    const sample = input();
    sample["policyholders.json"][0]!.id_last4 = "PRIVATE-SENTINEL";
    const error = expectInvalid(sample, "policyholders.json", "invalid_structure");
    expect(error.pointer).toBe("/0/id_last4");
    expect(String(error)).not.toContain("PRIVATE-SENTINEL");
    expect(JSON.stringify(error)).not.toContain("Margaret");
  });

  test("Bun loader distinguishes missing files from invalid JSON and reports no raw parser text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fixture-data-"));
    try {
      await expect(loadFixtureData({ directory, clock })).rejects.toMatchObject({
        code: "read_failed",
      });
      await Promise.all(
        fileNames.map((file) => Bun.write(join(directory, file), JSON.stringify(realInput[file]))),
      );
      await Bun.write(join(directory, "claims.json"), '{"private":"PRIVATE-SENTINEL",');
      await expect(loadFixtureData({ directory, clock })).rejects.toMatchObject({
        file: "claims.json",
        code: "invalid_json",
      });
      try {
        await loadFixtureData({ directory, clock });
      } catch (error) {
        expect(String(error)).not.toContain("PRIVATE-SENTINEL");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([NaN, Infinity, 1.5, 9_000_000_000_000_000])(
    "reject invalid clock %s",
    async (value) => {
      const data = createFixtureData(input(), { clock: { now: () => value } });
      await expect(data.getCase("P9", "CL-2048")).rejects.toThrow(
        "Clock must return valid Unix milliseconds",
      );
    },
  );
});
