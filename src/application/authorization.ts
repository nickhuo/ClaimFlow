import { collectedFacts, RuleViolation } from "../domain/conversation.ts";
import { normalizeIdentity } from "../domain/identity.ts";
import type { BusinessContext } from "./conversation/context.ts";

export async function requestAuthorization(context: BusinessContext) {
  context.authorizationChecked = true;
  const { state } = await context.read();
  const facts = collectedFacts(state);
  if (facts.role !== "representative") return { status: "not_required" as const };
  if (state.identity.status !== "verified" || !facts.representedPolicyNumber) {
    await context.commit({ type: "handoff", reason: "authorization_missing" });
    return { status: "denied" as const };
  }
  const representativeId = state.identity.subjectId;
  const [caller, target] = await Promise.all([
    context.dependencies.data.getPolicyholder(representativeId),
    context.dependencies.data.findPolicyholderByPolicyNumber(facts.representedPolicyNumber),
  ]);
  await context.read();
  const relationships = target
    ? await context.dependencies.data.getRepresentatives(target.value.subjectId)
    : [];
  await context.read();
  if (
    !caller ||
    !target ||
    !relationships.some(
      (entry) =>
        normalizeIdentity("fullName", entry.value.fullName) ===
        normalizeIdentity("fullName", caller.value.fullName),
    )
  ) {
    await context.commit({ type: "handoff", reason: "authorization_missing" });
    return { status: "denied" as const };
  }
  const now = context.dependencies.clock.now();
  const requestedAt =
    state.representativeAuthorization.status === "pending"
      ? state.representativeAuthorization.requestedAt
      : now;
  const grant =
    now >= requestedAt + context.dependencies.policy.authorizationTimeoutMs
      ? { status: "expired" as const }
      : await context.dependencies.authorization.check({
          sessionId: context.access.sessionId,
          representativeId,
          subjectId: target.value.subjectId,
          requestedAt,
          now,
          timeoutMs: context.dependencies.policy.authorizationTimeoutMs,
        });
  await context.read();
  if (
    grant.status === "approved" &&
    (grant.subjectId !== target.value.subjectId || grant.representativeId !== representativeId)
  )
    throw new RuleViolation("authorization_required");
  const checked =
    context.dependencies.clock.now() >=
    requestedAt + context.dependencies.policy.authorizationTimeoutMs
      ? { status: "expired" as const }
      : grant;
  await context.commit({ type: "authorization_checked", authorization: checked });
  return checked;
}
