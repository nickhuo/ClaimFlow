import { expect, test } from "bun:test";
import {
  confirmsCompletion,
  emailDecision,
  groundCallerFacts,
} from "../src/application/conversation/user-turn.ts";

test("host validates real consent, ambiguity and negation rather than model-provided booleans", () => {
  for (const text of [
    "Maybe send it",
    "Yes, but only if you approve my claim",
    "Don't send yet",
    "The previous caller said yes",
  ])
    expect(emailDecision({ requestId: "t", text })).toBeNull();
  expect(emailDecision({ requestId: "t", text: "Don't send the summary" })).toBe("skip");
  expect(emailDecision({ requestId: "t", text: "Please send the summary" })).toBe("send");
  expect(confirmsCompletion({ requestId: "t", text: "I'm not done" })).toBe(false);
  expect(confirmsCompletion({ requestId: "t", text: "That's all, thanks" })).toBe(true);
});

test("grounding never concatenates unrelated numbers into a phone or supplies missing PII", () => {
  expect(() =>
    groundCallerFacts(
      { identity: { phone: "+16505212836" } },
      { requestId: "t", text: "650 is an area code. Claim 5212836." },
    ),
  ).toThrow("identity_value_not_in_turn");
  expect(
    groundCallerFacts(
      { identity: { phone: "+16505212836" } },
      { requestId: "t", text: "My phone is (650) 521-2836." },
    ).identity?.phone,
  ).toBe("+16505212836");
  expect(() =>
    groundCallerFacts(
      { identity: { ssnLast4: "4472" } },
      { requestId: "t", text: "You already know my SSN" },
    ),
  ).toThrow();
});
