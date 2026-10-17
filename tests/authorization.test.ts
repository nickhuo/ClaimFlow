import { expect, test } from "bun:test";
import { loadFixtureData } from "../src/adapters/fixtures/index.ts";
import { mockAuthorization } from "../src/adapters/authorization/mock.ts";
import { BusinessContext } from "../src/application/conversation/context.ts";
import { BusinessOperations } from "../src/application/conversation/tools.ts";
import { setup } from "./helpers/conversation.ts";

async function representative(scenario = "default") {
  const fixture = await loadFixtureData();
  const reference = (await fixture.getPolicyholder("P9"))!;
  // Dedicated test identity, not a modification of the supplied production fixtures.
  const caller = {
    ...reference,
    value: {
      ...reference.value,
      subjectId: "TEST-REP",
      fullName: "David Chen",
      nameAliases: [],
      policyNumber: "REP-1",
      email: "david@example.com",
    },
  };
  const data = {
    ...fixture,
    findPolicyholderByPolicyNumber: async (policy: string) =>
      policy === "REP-1" ? caller : fixture.findPolicyholderByPolicyNumber(policy),
    getPolicyholder: async (id: string) =>
      id === "TEST-REP" ? caller : fixture.getPolicyholder(id),
  };
  const environment = await setup(0, { data, authorization: mockAuthorization(data, scenario) });
  const access = await environment.service.create();
  const operations = (turnId: string, text: string) =>
    new BusinessOperations(
      new BusinessContext(
        environment.service.dependencies,
        access,
        { requestId: turnId, text },
        new AbortController().signal,
        () => {},
      ),
    );
  const identity = {
    fullName: "David Chen",
    dateOfBirth: "1985-03-15",
    email: "david@example.com",
  };
  const first = operations(
    "first",
    "My name is David Chen, DOB 1985-03-15, email david@example.com. My policy REP-1. On behalf of policy POL-9921, why was the healthcare claim denied?",
  );
  await first.execute("record_facts", {
    turnId: "first",
    facts: {
      role: "representative",
      policyNumber: "REP-1",
      representedPolicyNumber: "POL-9921",
      identity,
      intent: "denial_question",
      caseHints: { caseType: "healthcare", claimedStatus: "denied" },
    },
  });
  await first.execute("verify_identity", { turnId: "first" });
  return { ...environment, access, first, operations };
}

test("verified representative stays blocked while pending; scoped mock approval then permits only target claims", async () => {
  const { service, access, first, operations } = await representative();
  try {
    await expect(first.execute("read_case", { caseId: "CL-2048" })).rejects.toThrow();
    expect(await first.execute("request_authorization", { turnId: "first" })).toMatchObject({
      status: "pending",
    });
    expect((await service.view(access)).verified).toBe(false);
    const next = operations("second", "Check my authorization");
    expect(await next.execute("request_authorization", { turnId: "second" })).toMatchObject({
      status: "approved",
      scope: "claims:read",
      subjectId: "P9",
      representativeId: "TEST-REP",
      source: "mock",
    });
    await next.execute("resolve_case", { turnId: "second" });
    await expect(next.execute("read_case", { caseId: "CL-3001" })).rejects.toThrow(
      "case_unavailable",
    );
    expect(await next.execute("read_case", { caseId: "CL-2048" })).toMatchObject({
      value: { subjectId: "P9" },
    });
  } finally {
    await service.close();
  }
});

test("pending authorization times out without releasing any case data", async () => {
  const { service, access, first, operations, advance } = await representative("timeout");
  try {
    await first.execute("request_authorization", { turnId: "first" });
    advance(30_000);
    expect(
      await operations("second", "Check again").execute("request_authorization", {
        turnId: "second",
      }),
    ).toMatchObject({ status: "expired" });
    expect((await service.view(access)).handoff?.reason).toBe("authorization_timeout");
    expect((await service.view(access)).verified).toBe(false);
    await expect(service.outbox(access)).rejects.toThrow();
  } finally {
    await service.close();
  }
});
