import type { ConversationState } from "../../domain/conversation.ts";
import type { CustomerReply } from "../session-ports.ts";

function privateValues(state: ConversationState): string[] {
  return state.callerFacts
    .flatMap(({ value }) => [
      ...Object.values(value.identity ?? {}),
      ...(value.policyNumber ? [value.policyNumber] : []),
      ...(value.representedPolicyNumber ? [value.representedPolicyNumber] : []),
    ])
    .filter(Boolean);
}

export function customerReplyInput(
  question: string,
  approvedResponse: string,
  state: ConversationState,
): CustomerReply {
  // Wording does not need identity values that the business loop has already collected.
  for (const value of privateValues(state).sort((a, b) => b.length - a.length))
    question = question.replaceAll(
      new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      "[private detail]",
    );
  return { question, approvedResponse };
}

const numbers = (text: string) => text.match(/\d+(?:[.,/-]\d+)*/g) ?? [];

/** Conservative output checks, not a claim of complete semantic verification. */
export function acceptsCustomerReply(
  reply: string,
  approvedResponse: string,
  state: ConversationState,
): boolean {
  if (!reply.trim() || reply.length > 8000) return false;
  const lower = reply.toLowerCase();
  if (privateValues(state).some((value) => lower.includes(value.toLowerCase()))) return false;
  const permittedNumbers = new Set(numbers(approvedResponse));
  if (numbers(reply).some((number) => !permittedNumbers.has(number))) return false;
  const requiredReferences = approvedResponse.match(/\bCL-[\w-]+\b|\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
  if (requiredReferences.some((reference) => !reply.includes(reference))) return false;
  const references =
    reply.match(/\b(?:CL|POL)-[\w-]+\b|\b[^\s@]+@[^\s@]+\.[^\s@]+\b|https?:\/\/\S+/gi) ?? [];
  return references.every((reference) => approvedResponse.includes(reference));
}
