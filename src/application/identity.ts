import { collectedFacts, RuleViolation } from "../domain/conversation.ts";
import { assessIdentityEvidence, IDENTITY_FIELDS, matchIdentity } from "../domain/identity.ts";
import type { BusinessContext } from "./conversation/context.ts";

export async function verifyIdentity(context: BusinessContext) {
  const facts = collectedFacts((await context.read()).state);
  const supplied = facts.identity ?? {};
  const holder = facts.policyNumber
    ? await context.dependencies.data.findPolicyholderByPolicyNumber(
        facts.policyNumber.trim().toUpperCase(),
      )
    : await context.dependencies.data.findPolicyholderByIdentity(supplied);
  await context.read();
  const evidence = holder
    ? matchIdentity(supplied, holder.value)
    : IDENTITY_FIELDS.filter((field) => supplied[field]).map((field) => ({
        origin: "identity_verifier" as const,
        subjectId: "unresolved",
        field,
        outcome: "mismatch" as const,
      }));
  if (!evidence.length) return { status: "insufficient" as const, matchedFields: [] };
  const next = await context.commit({
    type: "identity_checked",
    turnId: context.input.requestId,
    evidence,
    sources: holder?.sources ?? [
      { adapter: "verifier", resource: "policyholder_lookup", pointer: "" },
    ],
  });
  if (facts.role === "representative" && !holder)
    await context.commit({ type: "handoff", reason: "authorization_missing" });
  return assessIdentityEvidence(next.state.evidence);
}

export function requireOriginatingTurn(context: BusinessContext, turnId: string): void {
  if (context.input.requestId !== turnId) throw new RuleViolation("originating_turn_required");
}
