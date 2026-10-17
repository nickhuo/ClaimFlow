import { RuleViolation, type CallerFacts } from "../../domain/conversation.ts";
import { normalizeIdentity, type IdentityField } from "../../domain/identity.ts";
import { dateOfBirthMentions, normalizeDateOfBirth } from "../../domain/date-of-birth.ts";
import type { TurnInput } from "../session-ports.ts";

const normalized = (value: string) =>
  value.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
const plain = (value: string) =>
  normalized(value)
    .replace(/[.!]+$/g, "")
    .trim();

/** Model extraction can only retain identity values actually present in this originating turn. */
export function groundCallerFacts(facts: CallerFacts, input: TurnInput): CallerFacts {
  const text = normalized(input.text);
  let grounded = facts;
  for (const [key, value] of Object.entries(facts.identity ?? {})) {
    const field = key as IdentityField;
    if (field === "dateOfBirth") {
      const date = normalizeDateOfBirth(value);
      const source =
        dateOfBirthMentions(input.text).find(
          (candidate) =>
            normalized(candidate) === normalized(value) ||
            (date !== null && normalizeDateOfBirth(candidate) === date),
        ) ?? (date === null && text.includes(normalized(value)) ? value : undefined);
      if (!source) throw new RuleViolation("identity_value_not_in_turn");
      // Keep the actual caller expression for provenance, redaction, and format clarification.
      grounded = { ...facts, identity: { ...facts.identity, dateOfBirth: source } };
      continue;
    }
    const supplied = normalizeIdentity(field, value);
    const present =
      field === "phone"
        ? [...input.text.matchAll(/(?<![\d+])\+?\d[\d ().-]{8,}\d(?!\d)/g)].some(
            ([candidate]) => normalizeIdentity("phone", candidate) === supplied,
          )
        : field === "ssnLast4"
          ? /^(\d{4})$/.test(supplied) &&
            new RegExp(`(?:^|\\D)${supplied}(?:$|\\D)`).test(input.text)
          : text.includes(normalized(supplied));
    if (!present) throw new RuleViolation("identity_value_not_in_turn");
  }
  for (const value of [
    facts.policyNumber,
    facts.representedPolicyNumber,
    facts.caseHints?.caseId,
  ]) {
    if (value && !text.includes(normalized(value)))
      throw new RuleViolation("reference_not_in_turn");
  }
  const representative =
    /\b(on behalf|representative|calling for my|my (mother|father|wife|husband|parent)'?s? claim)\b/i.test(
      input.text,
    );
  if (representative && facts.role === "policyholder")
    throw new RuleViolation("caller_role_conflict");
  return representative ? { ...grounded, role: "representative" } : grounded;
}

export function confirmsCompletion(input: TurnInput): boolean {
  return (
    input.action?.type === "finish" ||
    /^(no(,? thanks)?[, ]+)?(that'?s all|that is all|no (more|further) questions|i'?m done|i am done|finish|done)([, ]+(thanks|thank you))?$/.test(
      plain(input.text),
    )
  );
}
export function emailDecision(input: TurnInput): "send" | "skip" | null {
  if (input.action?.type === "send" || input.action?.type === "skip") return input.action.type;
  const text = plain(input.text);
  if (/^retry( (sending|email|the email|the summary))?$/.test(text)) return "send";
  if (
    /^(skip( (it|the email|email))?|no(,? thanks)?|do not (send|email)( (it|me|the summary|the email))?|don'?t (send|email)( (it|me|the summary|the email))?|no email)$/.test(
      text,
    )
  )
    return "skip";
  if (
    /^(yes(,? please)?|please (send|email)( (it|me|the summary|the email))?|send( (it|the summary|the email|summary))?(,? please)?|email (me|the summary))( to [^\s@]+@[^\s@]+\.[^\s@]+)?$/.test(
      text,
    )
  )
    return "send";
  return null;
}
export function requestsHuman(input: TurnInput): boolean {
  return (
    input.action?.type === "handoff" ||
    /^(i (want|need|would like) (to (talk|speak) to )?(a )?)?(human|agent|representative|human representative)( please)?$|^(please )?(transfer|connect) me( to (a )?(human|agent|representative))?$/.test(
      plain(input.text),
    )
  );
}
export function suppliedRecipient(input: TurnInput): string | null {
  if (input.action?.type === "send") return input.action.recipient?.trim().toLowerCase() ?? null;
  return input.text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0]?.toLowerCase() ?? null;
}
