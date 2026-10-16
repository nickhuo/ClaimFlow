import { describe, expect, test } from "bun:test";
import {
  assessIdentityEvidence,
  type IdentityEvidence,
  type IdentityField,
} from "../src/domain/identity.ts";
import { DEFAULT_SOP_POLICY } from "../src/domain/conversation.ts";
import { readSopPolicy } from "../src/application/config.ts";
import { PHASE_TOOLS } from "../src/application/tool-contracts.ts";

function match(field: IdentityField, subjectId = "subject-1"): IdentityEvidence {
  return { origin: "identity_verifier", field, subjectId, outcome: "match" };
}

describe("identity evidence policy", () => {
  test("three different matched fields for one subject satisfy the threshold", () => {
    expect(
      assessIdentityEvidence([match("fullName"), match("dateOfBirth"), match("ssnLast4")]),
    ).toEqual({
      status: "verified",
      subjectId: "subject-1",
      matchedFields: ["fullName", "dateOfBirth", "ssnLast4"],
    });
  });

  test("repeating a field cannot satisfy the threshold", () => {
    expect(assessIdentityEvidence([match("email"), match("email"), match("email")])).toEqual({
      status: "insufficient",
      matchedFields: ["email"],
    });
  });

  test("no fields and two fields still require input", () => {
    expect(assessIdentityEvidence([]).status).toBe("insufficient");
    expect(assessIdentityEvidence([match("phone"), match("email")]).status).toBe("insufficient");
  });

  test("three matches do not override an unresolved conflict", () => {
    const result = assessIdentityEvidence([
      match("fullName"),
      match("dateOfBirth"),
      match("ssnLast4"),
      { ...match("email"), outcome: "mismatch" },
    ]);
    expect(result.status).toBe("conflict");
    if (result.status === "conflict") expect(result.conflictingFields).toEqual(["email"]);
  });

  test("matches belonging to different subjects cannot be combined", () => {
    expect(
      assessIdentityEvidence([match("fullName"), match("email"), match("phone", "subject-2")]),
    ).toMatchObject({
      status: "conflict",
      reason: "subject_mismatch",
    });
  });

  test("policy numbers and user assertions are not verifier evidence", () => {
    for (const invalid of [
      { ...match("email"), field: "policyNumber" },
      { ...match("email"), origin: "user" },
    ]) {
      expect(assessIdentityEvidence([invalid as IdentityEvidence])).toMatchObject({
        status: "conflict",
        reason: "invalid_evidence",
      });
    }
  });
});

describe("configuration and exposure contract", () => {
  test("defaults and explicit positive integer overrides", () => {
    expect(readSopPolicy({})).toEqual(DEFAULT_SOP_POLICY);
    expect(readSopPolicy({ MAX_IDENTITY_FAILURES: "5", AUTHORIZATION_TIMEOUT_MS: "1000" })).toEqual(
      {
        ...DEFAULT_SOP_POLICY,
        maxIdentityFailures: 5,
        authorizationTimeoutMs: 1_000,
      },
    );
  });

  test.each(["0", "-1", "1.5", "", "abc", "9007199254740992"])(
    "reject invalid policy value %s",
    (value) => {
      expect(() => readSopPolicy({ MAX_IDENTITY_FAILURES: value })).toThrow(
        "positive safe integer",
      );
    },
  );

  test("verification exposes no case or email actions; facts and handoff remain available", () => {
    expect(PHASE_TOOLS.VERIFY_ID).not.toContain("read_case");
    expect(PHASE_TOOLS.VERIFY_ID).not.toContain("send_summary");
    for (const tools of Object.values(PHASE_TOOLS)) {
      expect(tools).toContain("record_facts");
      expect(tools).toContain("handoff");
    }
  });
});
