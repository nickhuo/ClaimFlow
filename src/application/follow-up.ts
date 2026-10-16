import { RuleViolation } from "../domain/conversation.ts";
import type { BusinessContext } from "./conversation/context.ts";
import { buildSummary } from "./conversation/reply.ts";
import { confirmsCompletion, emailDecision, suppliedRecipient } from "./conversation/user-turn.ts";

export function completeCase(context: BusinessContext) {
  context.commit({
    type: "finish",
    confirmed: confirmsCompletion(context.input),
    summary: buildSummary(context.read().state),
  });
  return { phase: "POST_PROCESS" as const };
}
export async function setEmailConsent(
  context: BusinessContext,
  decision: "send" | "skip",
  summaryVersion: number,
) {
  const state = context.read().state;
  if (emailDecision(context.input) !== decision)
    throw new RuleViolation("explicit_email_choice_required");
  if (
    (context.input.action?.type === "send" || context.input.action?.type === "skip") &&
    context.input.action.summaryVersion !== summaryVersion
  )
    throw new RuleViolation("current_summary_consent_required");
  let recipient = suppliedRecipient(context.input);
  if (decision === "send" && !recipient) {
    if (state.identity.status !== "verified") throw new RuleViolation("verification_required");
    const holder = await context.dependencies.data.getPolicyholder(state.identity.subjectId);
    recipient = holder?.value.email ?? null;
  }
  const next = context.commit({
    type: "email_choice",
    decision,
    confirmed: true,
    recipient: recipient ?? "",
    summaryVersion,
    turnId: context.input.requestId,
  });
  const consent = next.state.emailConsent;
  // Reference contact details stay server-side even after successful verification.
  return consent.status === "granted"
    ? { ...consent, recipient: maskEmail(consent.recipient) }
    : consent;
}
export function maskEmail(recipient: string): string {
  const [local, domain] = recipient.split("@");
  return `${local?.slice(0, 1) ?? ""}•••@${domain ?? ""}`;
}
export async function sendSummary(context: BusinessContext, summaryVersion: number) {
  const current = context.read();
  context.subject();
  if (
    current.state.emailConsent.status !== "granted" ||
    current.state.emailConsent.summaryVersion !== summaryVersion ||
    current.state.summary?.version !== summaryVersion
  )
    throw new RuleViolation("current_summary_consent_required");
  if (context.deliveryAttempted && current.state.delivery)
    return { status: current.state.delivery.status, deliveryId: current.state.delivery.deliveryId };
  if (
    (!current.state.delivery || current.state.delivery.status === "failed") &&
    (current.state.emailConsent.confirmationTurnId !== context.input.requestId ||
      emailDecision(context.input) !== "send")
  )
    throw new RuleViolation("explicit_email_choice_required");
  context.deliveryAttempted = true;
  const { record, attempt } = context.dependencies.store.reserveDelivery(
    context.access,
    current.version,
    context.dependencies.clock.now(),
  );
  let status = record.status;
  if (attempt) {
    context.commit({
      type: "delivery_updated",
      summaryVersion,
      delivery: { deliveryId: record.id, status: "pending" },
    });
    try {
      status = await context.dependencies.email.send(record, context.signal);
    } catch {
      status = "unknown";
    }
    // Receipt reconciliation survives cancellation; a cancelled request never implies that nothing was sent.
    context.dependencies.store.updateDelivery(record.id, status);
  } else if (status === "unknown" || status === "pending") {
    try {
      status = await context.dependencies.email.reconcile(record);
    } catch {
      status = "unknown";
    }
    context.dependencies.store.updateDelivery(record.id, status);
  }
  context.commit({
    type: "delivery_updated",
    summaryVersion,
    delivery: { deliveryId: record.id, status },
  });
  return { status, deliveryId: record.id };
}
