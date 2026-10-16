import { expect, test } from "bun:test";
import {
  initialConversation,
  transition,
  authorizedSubject,
  DEFAULT_SOP_POLICY,
} from "../../src/domain/conversation.ts";
import { matchIdentity } from "../../src/domain/identity.ts";

const now = Date.parse("2026-10-15T12:00:00Z");
const holder = {
  subjectId: "P9",
  fullName: "Margaret Chen",
  nameAliases: [],
  policyNumber: "POL-9921",
  dateOfBirth: "1985-03-15",
  identifier: { type: "ssn_last4" as const, last4: "4472" },
  phone: "+16505212836",
  phoneAliases: [],
  email: "margaret@email.com",
  emailAliases: [],
};

test("caller statements cannot grant access; three independently matched fields advance verification", () => {
  const facts = {
    role: "policyholder" as const,
    policyNumber: "POL-9921",
    identity: {
      fullName: "  MARGARET   Chen ",
      dateOfBirth: "1985-03-15",
      ssnLast4: "4472",
    },
  };
  let state = transition(initialConversation(), { type: "record", turnId: "t1", facts }, now);
  expect(() => authorizedSubject(state, now, DEFAULT_SOP_POLICY)).toThrow("verification_required");
  state = transition(
    state,
    {
      type: "identity_checked",
      turnId: "t1",
      evidence: matchIdentity(facts.identity, holder),
      sources: [{ adapter: "fixtures", resource: "policyholders.json", pointer: "/0" }],
    },
    now,
  );
  expect(state.phase).toBe("RESOLVE_INTENT");
  expect(authorizedSubject(state, now, DEFAULT_SOP_POLICY)).toBe("P9");
  expect(state.identityAudit[0]?.turnId).toBe("t1");
});

test("conflicts survive three matches until corrected; repeated fields and absent fields never add matches", () => {
  let state = initialConversation();
  const evidence = matchIdentity(
    {
      fullName: "Margaret Chen",
      dateOfBirth: "1985-03-15",
      ssnLast4: "4472",
      email: "wrong@example.com",
    },
    holder,
  );
  state = transition(
    state,
    { type: "identity_checked", turnId: "one", evidence, sources: [] },
    now,
  );
  expect(state.identity.status).toBe("unverified");
  expect(state.identityFailures).toBe(1);
  state = transition(
    state,
    { type: "identity_checked", turnId: "one", evidence, sources: [] },
    now,
  );
  expect(state.identityFailures).toBe(1);
  state = transition(
    state,
    {
      type: "identity_checked",
      turnId: "two",
      evidence: matchIdentity({ email: "MARGARET@EMAIL.COM" }, holder),
      sources: [],
    },
    now,
  );
  expect(state.identity.status).toBe("verified");
  expect(state.identityFailures).toBe(0);
  let partial = initialConversation();
  for (let i = 0; i < 5; i++)
    partial = transition(
      partial,
      {
        type: "identity_checked",
        turnId: String(i),
        evidence: matchIdentity({ fullName: "Margaret Chen" }, holder),
        sources: [],
      },
      now,
    );
  expect(partial.identity.status).toBe("unverified");
  expect(partial.evidence).toHaveLength(1);
  expect(partial.identityFailures).toBe(0);
});

test("new identity assertions invalidate previous access before the next verification; identity expires", () => {
  let state = transition(
    initialConversation(),
    {
      type: "record",
      turnId: "one",
      facts: { role: "policyholder", identity: { fullName: "Margaret Chen" } },
    },
    now,
  );
  state = transition(
    state,
    {
      type: "identity_checked",
      turnId: "one",
      evidence: matchIdentity(
        { fullName: "Margaret Chen", dateOfBirth: "1985-03-15", ssnLast4: "4472" },
        holder,
      ),
      sources: [],
    },
    now,
  );
  expect(() => authorizedSubject(state, now + DEFAULT_SOP_POLICY.sessionIdleTimeoutMs)).toThrow(
    "verification_required",
  );
  state = transition(
    state,
    { type: "record", turnId: "two", facts: { identity: { email: "wrong@example.com" } } },
    now,
  );
  expect(state.phase).toBe("VERIFY_ID");
  expect(() => authorizedSubject(state, now)).toThrow("verification_required");
});

test("representative identity does not substitute for a scoped grant or extend its validity", () => {
  let state = transition(
    initialConversation(),
    { type: "record", turnId: "one", facts: { role: "representative" } },
    now,
  );
  state = transition(
    state,
    {
      type: "identity_checked",
      turnId: "one",
      evidence: matchIdentity(
        { fullName: "Margaret Chen", dateOfBirth: "1985-03-15", ssnLast4: "4472" },
        holder,
      ),
      sources: [],
    },
    now,
  );
  expect(state.phase).toBe("VERIFY_ID");
  expect(() => authorizedSubject(state, now)).toThrow("authorization_required");
  state = transition(
    state,
    { type: "authorization_checked", authorization: { status: "pending", requestedAt: now } },
    now,
  );
  expect(() => authorizedSubject(state, now)).toThrow("authorization_required");
  state = transition(
    state,
    {
      type: "authorization_checked",
      authorization: {
        status: "approved",
        representativeId: "P9",
        subjectId: "P7",
        grantId: "grant",
        scope: "claims:read",
        expiresAt: now + 1000,
        source: "mock",
      },
    },
    now,
  );
  expect(authorizedSubject(state, now)).toBe("P7");
  expect(() => authorizedSubject(state, now + 1000)).toThrow("authorization_required");
});

test("mixed questions reset consecutive off-topic count, repeated turns count once, and exhaustion requests handoff", () => {
  let state = initialConversation();
  state = transition(state, { type: "record", turnId: "1", facts: { scope: "out_of_scope" } }, now);
  state = transition(state, { type: "record", turnId: "1", facts: { scope: "out_of_scope" } }, now);
  expect(state.consecutiveOffTopic).toBe(1);
  state = transition(state, { type: "record", turnId: "2", facts: { scope: "mixed" } }, now);
  expect(state.consecutiveOffTopic).toBe(0);
  for (const turnId of ["3", "4", "5"])
    state = transition(state, { type: "record", turnId, facts: { scope: "out_of_scope" } }, now);
  expect(state.status).toBe("handoff_requested");
  expect(state.handoffReason).toBe("repeated_off_topic");
  expect(() => transition(state, { type: "resume" }, now)).toThrow("handoff_requested");
});

test("changing an implicit policyholder to a representative clears old evidence and cannot borrow identity", () => {
  let state = transition(
    initialConversation(),
    {
      type: "record",
      turnId: "one",
      facts: {
        identity: { fullName: "Margaret Chen", dateOfBirth: "1985-03-15", ssnLast4: "4472" },
      },
    },
    now,
  );
  state = transition(
    state,
    {
      type: "identity_checked",
      turnId: "one",
      evidence: matchIdentity(
        { fullName: "Margaret Chen", dateOfBirth: "1985-03-15", ssnLast4: "4472" },
        holder,
      ),
      sources: [],
    },
    now,
  );
  state = transition(
    state,
    { type: "record", turnId: "two", facts: { role: "representative" } },
    now,
  );
  expect(state.identity.status).toBe("unverified");
  expect(state.evidence).toHaveLength(0);
  expect(() => authorizedSubject(state, now)).toThrow("verification_required");
});
