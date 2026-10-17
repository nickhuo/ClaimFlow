import { expect, test } from "bun:test";
import { sample, setup } from "./helpers/conversation.ts";
import { DEFAULT_SOP_POLICY } from "../src/domain/conversation.ts";

test("a naturally written birthday verifies without replacing the remembered claim month", async () => {
  const { service } = await setup();
  try {
    const access = service.create();
    const partial = await service.turn(access, {
      requestId: "one",
      text: "My name is Margaret Chen, policy POL-9921. Why was my January healthcare claim denied?",
    });
    expect(partial.view.verified).toBe(false);
    const answer = await service.turn(access, {
      requestId: "two",
      text: "My date of birth is March 15, 1985, and my SSN last four is 4472.",
    });
    expect(answer.error).toBeNull();
    expect(answer.view.phase).toBe("PROCESS_CASE");
    expect(answer.view.verified).toBe(true);
    expect(answer.reply).toContain("CL-2048");
    expect(answer.reply).not.toContain("1985");
  } finally {
    await service.close();
  }
});

test.each(["03/04/1985", "February 30, 1985"])(
  "unclear or invalid DOB asks for clarification and accepts a later correction: %s",
  async (dateOfBirth) => {
    const { service } = await setup();
    try {
      const access = service.create();
      const first = await service.turn(access, {
        requestId: "one",
        text: `My name is Margaret Chen, policy POL-9921, DOB is ${dateOfBirth}, SSN last four 4472. Why was my January healthcare claim denied?`,
      });
      expect(first.error).toBeNull();
      expect(first.view.verified).toBe(false);
      expect(first.view.phase).toBe("VERIFY_ID");
      expect(first.reply).toContain("spell out the month");
      expect(first.reply).not.toContain("CL-2048");
      const corrected = await service.turn(access, {
        requestId: "two",
        text: "My date of birth is March 15, 1985.",
      });
      expect(corrected.error).toBeNull();
      expect(corrected.view.verified).toBe(true);
      expect(corrected.reply).toContain("CL-2048");
    } finally {
      await service.close();
    }
  },
);

test("brief single-turn example crosses verified gates through real Pi, answers from facts, then skips email", async () => {
  const { service, traces } = await setup();
  try {
    const access = service.create();
    const first = await service.turn(access, { requestId: "one", text: sample });
    expect(first.error).toBeNull();
    expect(first.view.phase).toBe("PROCESS_CASE");
    expect(first.view.verified).toBe(true);
    expect(first.reply).toContain("CL-2048");
    expect(first.reply).toContain("pathology report");
    expect(first.reply).toContain("2026-03-18");
    expect(first.reply).toContain("has passed");
    expect(first.reply).not.toContain("4472");
    expect(traces).toContain("agent_settled");
    const summary = await service.turn(access, { requestId: "two", text: "That's all" });
    expect(summary.view.phase).toBe("POST_PROCESS");
    expect(summary.view.summary?.text).toContain("CL-2048");
    expect(summary.view.summary?.text).not.toContain("1985-03-15");
    const skipped = await service.turn(access, { requestId: "three", text: "Skip email" });
    expect(skipped.view.status).toBe("completed");
    expect(service.outbox(access)).toHaveLength(0);
  } finally {
    await service.close();
  }
});

test("partial verification retains early intent, blocks disclosure, and resolves once enough fields match", async () => {
  const { service } = await setup();
  try {
    const access = service.create();
    const partial = await service.turn(access, {
      requestId: "one",
      text: "My name is Margaret Chen, policy POL-9921. My healthcare claim from January was denied.",
    });
    expect(partial.view.phase).toBe("VERIFY_ID");
    expect(partial.reply).not.toContain("pathology");
    expect(partial.reply).not.toContain("CL-2048");
    const verified = await service.turn(access, {
      requestId: "two",
      text: "DOB is 1985-03-15, SSN last four is 4472.",
    });
    expect(verified.view.phase).toBe("PROCESS_CASE");
    expect(verified.reply).toContain("CL-2048");
  } finally {
    await service.close();
  }
});

test("foreign claim hints do not reveal existence and switching an owned claim discards old facts", async () => {
  const { service } = await setup();
  try {
    const access = service.create();
    await service.turn(access, { requestId: "one", text: sample });
    const switched = await service.turn(access, {
      requestId: "two",
      text: "Tell me about claim CL-2102",
    });
    expect(switched.reply).toContain("CL-2102");
    expect(switched.reply).not.toContain("pathology");
    const foreign = await service.turn(access, {
      requestId: "three",
      text: "Tell me about CL-3001",
    });
    expect(foreign.reply).toContain("couldn't locate");
    expect(foreign.reply).not.toContain("diagnosis report");
    expect(foreign.reply).not.toContain("CL-3001");
  } finally {
    await service.close();
  }
});

test("email failure stays failed until a new explicit retry; duplicates create one logical delivery", async () => {
  const { service } = await setup(1);
  try {
    const access = service.create();
    await service.turn(access, { requestId: "one", text: sample });
    await service.turn(access, { requestId: "two", text: "That's all" });
    const failed = await service.turn(access, { requestId: "three", text: "Send the summary" });
    expect(failed.error).toBeNull();
    expect(failed.view.delivery?.status).toBe("failed");
    expect(failed.view.status).toBe("active");
    expect(await service.turn(access, { requestId: "three", text: "Send the summary" })).toEqual(
      failed,
    );
    const retried = await service.turn(access, { requestId: "four", text: "Retry email" });
    expect(retried.view.delivery?.status).toBe("mock_recorded");
    expect(retried.view.status).toBe("completed");
    expect(service.outbox(access)).toHaveLength(1);
    expect(service.outbox(access)[0]?.recipient).toBe("m•••@email.com");
    await expect(
      service.turn(access, { requestId: "three", text: "Send the summary" }),
    ).rejects.toThrow("stale_request");
  } finally {
    await service.close();
  }
});

test("a follow-up resumes case processing and requires consent for a new summary version", async () => {
  const { service } = await setup();
  try {
    const access = service.create();
    await service.turn(access, { requestId: "one", text: sample });
    const firstSummary = await service.turn(access, { requestId: "two", text: "That's all" });
    const answer = await service.turn(access, {
      requestId: "three",
      text: "What is the reimbursement amount?",
    });
    expect(answer.view.phase).toBe("PROCESS_CASE");
    expect(answer.reply).toContain("USD 0.00");
    expect(answer.view.summary).toBeNull();
    const secondSummary = await service.turn(access, { requestId: "four", text: "That's all" });
    expect(secondSummary.view.summary?.version).toBe((firstSummary.view.summary?.version ?? 0) + 1);
    const stale = await service.turn(access, {
      requestId: "five",
      text: "Send",
      action: { type: "send", summaryVersion: 1 },
    });
    expect(stale.view.status).toBe("active");
    expect(service.outbox(access)).toHaveLength(0);
  } finally {
    await service.close();
  }
});

test("independent sessions can run concurrently; same-session duplicates serialize without repeated verification", async () => {
  const { service, advance } = await setup();
  try {
    const a = service.create();
    const b = service.create();
    const input = { requestId: "same", text: sample };
    const [one, duplicate, other] = await Promise.all([
      service.turn(a, input),
      service.turn(a, input),
      service.turn(b, { requestId: "same", text: "Why was my claim denied? This is ridiculous." }),
    ]);
    expect(one).toEqual(duplicate);
    expect(other.view.verified).toBe(false);
    expect(other.reply).toContain("frustrating");
    expect(other.reply).not.toContain("pathology");
    const fresh = await service.reset(a);
    expect(fresh.view.phase).toBe("VERIFY_ID");
    expect(fresh.view.summary).toBeNull();
    await expect(service.turn(a, { requestId: "late", text: "Read the claim" })).rejects.toThrow(
      "session_expired",
    );
    advance(DEFAULT_SOP_POLICY.sessionIdleTimeoutMs);
    expect(() => service.view(b)).toThrow("session_expired");
  } finally {
    await service.close();
  }
});

test("out-of-scope repetition requests a simulated human handoff without granting authority", async () => {
  const { service } = await setup();
  try {
    const access = service.create();
    for (const requestId of ["1", "2"]) {
      const reply = await service.turn(access, { requestId, text: "What is RL?" });
      expect(reply.view.status).toBe("active");
      expect(reply.reply).toContain("insurance");
    }
    const handoff = await service.turn(access, { requestId: "3", text: "What is RL?" });
    expect(handoff.view.handoff?.simulated).toBe(true);
    expect(handoff.view.verified).toBe(false);
    expect(handoff.reply).toContain("No live representative");
  } finally {
    await service.close();
  }
});

test("BR-01: refusal offers alternate fields; name, phone and email can verify without DOB or SSN", async () => {
  const { service } = await setup();
  try {
    const access = service.create();
    const refusal = await service.turn(access, {
      requestId: "one",
      text: "I don't want to share my SSN. Why do you need my identity?",
    });
    expect(refusal.reply).toContain("You don't need to share that field");
    expect(refusal.reply).toContain("phone number");
    expect(refusal.view.verified).toBe(false);
    const alternate = await service.turn(access, {
      requestId: "two",
      text: "My name is Margaret Chen, phone is (650) 521-2836, email margaret@email.com. My policy POL-9921. Why was my January healthcare claim denied?",
    });
    expect(alternate.error).toBeNull();
    expect(alternate.view.phase).toBe("PROCESS_CASE");
    expect(alternate.reply).toContain("CL-2048");
  } finally {
    await service.close();
  }
});

test("BR-02: ambiguous authorized cases ask for a distinction and reuse the caller's later answer", async () => {
  const { service } = await setup();
  try {
    const access = service.create();
    const ambiguous = await service.turn(access, {
      requestId: "one",
      text: "My name is Margaret Chen, policy POL-9921, DOB 1985-03-15, SSN last four 4472. What is the status of my healthcare claim?",
    });
    expect(ambiguous.view.phase).toBe("RESOLVE_INTENT");
    expect(ambiguous.reply).toContain("Which claim");
    expect(ambiguous.reply).toContain("CL-2011");
    expect(ambiguous.reply).toContain("CL-2048");
    expect(ambiguous.reply).not.toContain("CL-3001");
    const selected = await service.turn(access, { requestId: "two", text: "The denied one" });
    expect(selected.view.phase).toBe("PROCESS_CASE");
    expect(selected.reply).toContain("CL-2048");
    expect(
      service.dependencies.store.read(access, service.dependencies.clock.now()).state.identityAudit,
    ).toHaveLength(1);
  } finally {
    await service.close();
  }
});

test("BR-03: grounded document alternatives, amounts and next steps carry into the optional email summary", async () => {
  const { service } = await setup();
  try {
    const access = service.create();
    await service.turn(access, { requestId: "one", text: sample });
    const documents = await service.turn(access, {
      requestId: "two",
      text: "What documents do I need?",
    });
    expect(documents.view.phase).toBe("PROCESS_CASE");
    expect(documents.reply).toContain("does not specify an original requirement");
    const alternatives = await service.turn(access, {
      requestId: "three",
      text: "I can't get the report. Are there alternatives?",
    });
    expect(alternatives.reply).toContain("acceptance of a substitute has not been confirmed");
    const amount = await service.turn(access, {
      requestId: "four",
      text: "What is the reimbursement amount?",
    });
    expect(amount.reply).toContain("USD 0.00");
    const summary = await service.turn(access, { requestId: "five", text: "That's all" });
    expect(summary.view.summary?.text).toContain("denied");
    expect(summary.view.summary?.text).toContain("USD 0.00");
    expect(summary.view.summary?.text).toContain("Next steps:");
    expect(summary.view.summary?.text).toContain("Document guidance:");
    expect(service.outbox(access)).toHaveLength(0);
    const sent = await service.turn(access, { requestId: "six", text: "Please send the summary" });
    expect(sent.view.status).toBe("completed");
    expect(service.outbox(access)[0]?.body).toBe(summary.view.summary!.text);
    expect(sent.reply).toContain("No real email was sent");
  } finally {
    await service.close();
  }
});

test("BR-04: mixed scope answers only the insurance part and resets repeated off-topic escalation", async () => {
  const { service } = await setup();
  try {
    const access = service.create();
    await service.turn(access, { requestId: "one", text: "What is RL?" });
    await service.turn(access, { requestId: "two", text: "What is RL?" });
    const mixed = await service.turn(access, {
      requestId: "three",
      text: `${sample} Also, what is RL?`,
    });
    expect(mixed.reply).toContain("insurance part");
    expect(mixed.reply).toContain("CL-2048");
    expect(mixed.reply).not.toContain("reinforcement learning");
    expect(mixed.view.status).toBe("active");
    const later = await service.turn(access, { requestId: "four", text: "What is RL?" });
    expect(later.view.status).toBe("active");
  } finally {
    await service.close();
  }
});

test.each([
  ["BR-05 anxiety", "I'm worried. Why was my claim denied?", "worrying"],
  ["BR-05 confusion", "I'm confused about my claim", "one step at a time"],
  [
    "BR-05 brief frustration example",
    "I already told you who I am. This is ridiculous. Just tell me why my claim was denied.",
    "frustrating",
  ],
])(
  "%s receives empathy and alternatives while all case facts stay protected",
  async (_name, text, empathy) => {
    const { service } = await setup();
    try {
      const answer = await service.turn(service.create(), { requestId: "one", text });
      expect(answer.reply).toContain(empathy);
      expect(answer.reply).toContain("three different identity details");
      expect(answer.reply).toContain("email address");
      expect(answer.reply).not.toContain("pathology");
      expect(answer.view.verified).toBe(false);
    } finally {
      await service.close();
    }
  },
);

test("BR-06: repeated identity refusal stops persuasion and offers simulated human assistance", async () => {
  const { service } = await setup();
  try {
    const access = service.create();
    for (const requestId of ["one", "two"])
      expect(
        (await service.turn(access, { requestId, text: "I refuse to share any identity details" }))
          .view.status,
      ).toBe("active");
    const escalated = await service.turn(access, {
      requestId: "three",
      text: "I refuse to share any identity details",
    });
    expect(escalated.view.handoff?.reason).toBe("identity_refusal");
    expect(escalated.reply).toContain("No live representative is connected");
    expect(escalated.view.verified).toBe(false);
  } finally {
    await service.close();
  }
});
