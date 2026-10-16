import { describe, expect, test } from "bun:test";
import { Case, CaseInvariantError, type CaseRecord } from "../../src/domain/claims.ts";

const now = Date.parse("2026-10-15T12:00:00.000Z");
function record(overrides: Partial<CaseRecord> = {}): CaseRecord {
  return {
    caseId: "case-1", subjectId: "subject-1", caseType: "healthcare",
    createdAt: "2026-01-12", status: "denied", summary: "Missing records",
    appealDeadline: "2026-03-18", amounts: { net_pay: "0.00" }, ...overrides,
  };
}

describe("Case", () => {
  test("ownership and original amounts are domain facts without a fixture or harness", () => {
    const caseModel = new Case(record({ amounts: { net_pay: "900719925474099312345.67", net_fee: "0000.00" } }));
    expect(caseModel.belongsTo("subject-1")).toBe(true);
    expect(caseModel.belongsTo("subject-2")).toBe(false);
    expect(caseModel.factsAt(now).amounts).toEqual({ net_pay: "900719925474099312345.67", net_fee: "0000.00" });
    expect(caseModel.factsAt(now).amounts).not.toHaveProperty("allowed_max_amount");
  });

  test("an appeal date stays original across future, today and past UTC reads", () => {
    const caseModel = new Case(record());
    expect(caseModel.factsAt(Date.parse("2026-03-17T23:59:59.999Z")).appealDeadlineStatus).toBe("future");
    expect(caseModel.factsAt(Date.parse("2026-03-18T00:00:00.000Z")).appealDeadlineStatus).toBe("today");
    expect(caseModel.factsAt(now)).toMatchObject({ appealDeadline: "2026-03-18", appealDeadlineStatus: "past", createdAt: "2026-01-12" });
  });

  test("unknown information and explicitly empty requirements retain different meanings", () => {
    const incomplete = record({ amounts: {} });
    delete (incomplete as { appealDeadline?: string | null }).appealDeadline;
    expect(new Case(incomplete).factsAt(now)).toMatchObject({
      denialReason: null, documentsNeeded: null, appealDeadline: null, appealDeadlineStatus: "not_provided", amounts: {},
    });
    expect(new Case(record({ documentsNeeded: [] })).factsAt(now).documentsNeeded).toEqual([]);
  });

  test.each([
    ["impossible creation date", { createdAt: "2026-02-30" }],
    ["impossible appeal date", { appealDeadline: "2025-02-29" }],
    ["appeal before creation", { appealDeadline: "2025-01-01" }],
    ["non-decimal amount", { amounts: { net_pay: "1e3" } }],
    ["empty subject", { subjectId: " " }],
  ])("reject %s in the domain", (_name, invalid) => {
    expect(() => new Case(record(invalid))).toThrow(CaseInvariantError);
  });

  test("caller mutations cannot change existing case facts", () => {
    const input = record({ documentsNeeded: ["office note"] });
    const caseModel = new Case(input);
    (input.amounts as Record<string, string>).net_pay = "999.00";
    (input.documentsNeeded as string[]).push("invented");
    const facts = caseModel.factsAt(now);
    (facts.documentsNeeded as string[]).push("more invented");
    expect(caseModel.factsAt(now).documentsNeeded).toEqual(["office note"]);
    expect(caseModel.factsAt(now).amounts.net_pay).toBe("0.00");
  });
});
