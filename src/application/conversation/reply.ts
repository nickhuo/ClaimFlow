import {
  authorizedSubject,
  collectedFacts,
  type ConversationState,
  type SopPolicy,
} from "../../domain/conversation.ts";
import type { SessionRecord, SessionView } from "../session-ports.ts";
import { normalizeDateOfBirth } from "../../domain/date-of-birth.ts";

const fieldLabels: Record<string, string> = {
  fullName: "full name",
  dateOfBirth: "date of birth",
  phone: "phone number",
  email: "email address",
  ssnLast4: "SSN last four digits",
};
const amountLabels: Record<string, string> = {
  expected_reimbursement_amount: "Expected reimbursement",
  allowed_max_amount: "Allowed maximum",
  net_pay: "Net payment",
  net_fee: "Net fee",
};
export function deadlineText(state: ConversationState): string {
  const facts = state.caseFacts?.value;
  if (!facts?.appealDeadline)
    return "No appeal deadline is provided in this record. A human representative can clarify the timing.";
  const timing =
    facts.appealDeadlineStatus === "past"
      ? "That recorded date has passed; an extension has not been confirmed. Please ask a human representative about available options."
      : facts.appealDeadlineStatus === "today"
        ? "That recorded date is today (UTC)."
        : "That recorded date is still ahead (UTC).";
  return `The recorded appeal deadline is ${facts.appealDeadline}. ${timing}`;
}
export function caseAnswer(state: ConversationState, topic?: string): string {
  const facts = state.caseFacts?.value;
  if (!facts)
    return "Your identity is verified. I'll need to locate and read the authorized claim before discussing its details.";
  const prefix = `Claim ${facts.caseId} is ${facts.status}.`;
  if (topic === "unknown")
    return "I don't have a verified claim-specific answer to that question. Please clarify what you need, or request a human representative.";
  if (topic === "amounts")
    return `${prefix}\n\n${
      Object.entries(facts.amounts)
        .map(([key, value]) => `${amountLabels[key] ?? key}: USD ${value}`)
        .join("\n") || "No amounts are provided in this record."
    }`;
  if (topic === "deadline") return `${prefix} ${deadlineText(state)}`;
  if (["documents", "alternatives", "submission", "processing_time"].includes(topic ?? ""))
    return state.guidance?.operationId === state.caseFacts?.operationId
      ? state.guidance!.value.guidance
      : "I need to check the document guidance for this question before giving specific instructions. Please try the question again or request human assistance.";
  if (topic === "denial" || facts.status === "denied")
    return `${prefix} ${facts.denialReason ? `The recorded reason is that ${facts.denialReason}.` : "The record does not provide a denial reason."}\n\n${facts.documentsNeeded === null ? "The record does not specify requested documents." : facts.documentsNeeded.length ? `Requested documents: ${facts.documentsNeeded.join(" and ")}.` : "No outstanding documents are listed."}\n\n${deadlineText(state)}`;
  return `${prefix} ${facts.summary}`;
}
export function buildSummary(state: ConversationState): string {
  return `Conversation summary\n\n${caseAnswer(state, "status")}${state.discussedTopics.includes("amounts") ? `\n\n${caseAnswer(state, "amounts")}` : ""}\n\nDiscussed: ${state.discussedTopics.join(", ") || "claim status"}.${state.guidance ? `\n\nDocument guidance: ${state.guidance.value.guidance}` : ""}\n\nNext steps: ${state.caseFacts?.value.documentsNeeded?.length ? "Obtain the requested documents and confirm submission or manual review options with support." : "Contact support if you need further clarification."} This conversation has not changed the claim decision.`;
}
export function sessionView(record: SessionRecord, now: number, policy: SopPolicy): SessionView {
  const state = record.state;
  let verified = false;
  try {
    authorizedSubject(state, now, policy);
    verified = true;
  } catch {
    /* Project only active authority. */
  }
  return {
    sessionId: record.id,
    version: record.version,
    phase: verified || state.status === "handoff_requested" ? state.phase : "VERIFY_ID",
    status: state.status,
    verified,
    authorization: state.representativeAuthorization.status,
    summary: verified ? state.summary : null,
    delivery: verified ? state.delivery : null,
    handoff: state.handoffReason
      ? { status: "requested", simulated: true, reason: state.handoffReason }
      : null,
  };
}
export function renderReply(
  state: ConversationState,
  now: number,
  policy: SopPolicy,
  clarification: string | null,
): string {
  const facts = collectedFacts(state);
  const empathy =
    facts.emotion === "frustrated"
      ? "I understand how frustrating this is. "
      : facts.emotion === "anxious"
        ? "I understand this can be worrying. "
        : facts.emotion === "confused"
          ? "Let's take this one step at a time. "
          : facts.emotion === "refusing"
            ? "You don't need to share that field. We can use other identity details, or ask for human assistance. "
            : "";
  if (state.status === "handoff_requested")
    return `${empathy}A human assistance request has been recorded in this demo. No live representative is connected. ${state.handoffReason === "authorization_timeout" ? "The authorization request timed out." : state.handoffReason === "documents_unavailable" ? "A representative should review the remaining document options." : "Please contact your insurer's support team to continue."}`;
  if (facts.scope === "out_of_scope")
    return "I can help with insurance claims, identity verification, documents, and follow-up. Please ask a claim-related question, or request a human representative.";
  const mixed =
    facts.scope === "mixed" ? "I can help with the insurance part of your question. " : "";
  let verified = false;
  try {
    authorizedSubject(state, now, policy);
    verified = true;
  } catch {
    /* Never expose stored case facts after authority expires. */
  }
  if (!verified) {
    if (state.representativeAuthorization.status === "pending")
      return `${empathy}Your representative authorization is still pending in the simulation. Claim details remain protected. You can check again or request human assistance.`;
    const fields = state.evidence
      .filter((item) => item.outcome === "match")
      .map((item) => item.field);
    const unclearDate =
      facts.identity?.dateOfBirth && normalizeDateOfBirth(facts.identity.dateOfBirth) === null;
    const conflicts = state.evidence
      .filter(
        (item) => item.outcome === "mismatch" && !(unclearDate && item.field === "dateOfBirth"),
      )
      .map((item) => fieldLabels[item.field]);
    return `${empathy}${mixed}To protect claim information, I need to verify at least three different identity details.${unclearDate ? " I couldn't interpret your date of birth as a valid, unambiguous date. Please spell out the month and include the day and full year." : ""}${conflicts.length ? ` Please check your ${conflicts.join(", ")}; the supplied details did not match.` : fields.length ? ` ${fields.length} of the required 3 details have matched.` : ""} You can provide ${[
      "fullName",
      "dateOfBirth",
      "phone",
      "email",
      "ssnLast4",
    ]
      .filter((field) => !fields.includes(field as (typeof fields)[number]))
      .map((field) => fieldLabels[field])
      .join(
        ", ",
      )}. Only the last four SSN digits are needed. You can also request human assistance.`;
  }
  if (clarification) return `${empathy}${mixed}${clarification}`;
  if (state.phase === "RESOLVE_INTENT")
    return `${empathy}Your identity is verified. Which claim or claim question would you like help with?`;
  if (state.phase === "POST_PROCESS") {
    if (state.emailConsent.status === "declined")
      return "All set. The email summary was skipped. You can return to your claim if another question comes up.";
    if (state.delivery?.status === "mock_recorded")
      return "The summary is recorded in the demo outbox. No real email was sent.";
    if (state.delivery?.status === "submitted")
      return "The email provider has accepted your summary for delivery. This does not confirm receipt.";
    if (state.delivery?.status === "failed")
      return "The summary could not be sent. You can retry the same delivery or skip the email.";
    if (state.delivery?.status === "unknown" || state.delivery?.status === "pending")
      return "The delivery result is not yet confirmed. Check its status before trying another send.";
    return "Here is the summary of our conversation. Would you like to send this version by email or skip it? You can also return to your claim.";
  }
  return `${empathy}${mixed}${caseAnswer(state, facts.topic)}\n\nWhat else would you like to know about this claim?`;
}
