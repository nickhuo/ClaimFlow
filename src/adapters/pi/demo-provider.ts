import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { CallerFacts } from "../../domain/conversation.ts";
import { dateOfBirthMentions } from "../../domain/date-of-birth.ts";
import type { TurnInput } from "../../application/session-ports.ts";
import {
  confirmsCompletion,
  emailDecision,
  requestsHuman,
} from "../../application/conversation/user-turn.ts";
import type { ProviderConfiguration } from "./harness.ts";

/** A labeled, deterministic demo provider. It still runs through Pi's actual agent/tool loop. */
export function demoProvider(): ProviderConfiguration {
  const faux = fauxProvider({
    provider: "demo",
    models: [{ id: "scripted-insurance", contextWindow: 32768, maxTokens: 1024 }],
  });
  const response = (context: TranscriptContext) => {
    const last = context.messages.findLast((message) => message.role === "user");
    const text =
      typeof last?.content === "string"
        ? last.content
        : (last?.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("") ?? "{}");
    const { callerTurn: input, authoritativeMemory: memory } = JSON.parse(text) as {
      callerTurn: TurnInput;
      authoritativeMemory: {
        phase: string;
        status: string;
        identity: string;
        role: string;
        recordedThisTurn: boolean;
        verifiedThisTurn: boolean;
        authorizationCheckedThisTurn: boolean;
        collectedIdentityFields: string[];
        selectedCaseId: string | null;
        caseReadThisTurn: boolean;
        guidanceReadThisTurn: boolean;
        topic: string | null;
        clarification: string | null;
        summaryVersion: number | null;
        emailConsent: string;
        delivery: string | null;
        deliveryAttemptedThisTurn: boolean;
        emailConsentThisTurn: boolean;
      };
    };
    if (!input || !memory) return fauxAssistantMessage("Session unavailable.");
    const call = (name: string, args: Record<string, unknown>) =>
      fauxAssistantMessage(fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1]));
    if (memory.status === "handoff_requested") return fauxAssistantMessage("Handoff requested.");
    if (requestsHuman(input)) return call("handoff", { reason: "caller_request" });
    if (memory.phase === "POST_PROCESS") {
      const decision = emailDecision(input);
      if (decision) {
        if (memory.status === "completed") return fauxAssistantMessage("Completed.");
        if (
          memory.emailConsent !== "granted" ||
          (memory.delivery === "failed" && !memory.emailConsentThisTurn) ||
          decision === "skip"
        )
          return call("set_email_consent", {
            decision,
            summaryVersion: memory.summaryVersion,
            confirmationTurnId: input.requestId,
          });
        if (
          decision === "send" &&
          !memory.deliveryAttemptedThisTurn &&
          !["mock_recorded", "submitted"].includes(memory.delivery ?? "")
        )
          return call("send_summary", { summaryVersion: memory.summaryVersion });
      } else if (!confirmsCompletion(input))
        return call("resume_case", { turnId: input.requestId });
      return fauxAssistantMessage("Awaiting email choice.");
    }
    if (!memory.recordedThisTurn)
      return call("record_facts", {
        turnId: input.requestId,
        facts: extractDemoFacts(input.text, memory.phase === "VERIFY_ID"),
      });
    if (memory.phase === "VERIFY_ID") {
      if (!memory.verifiedThisTurn && memory.collectedIdentityFields.length)
        return call("verify_identity", { turnId: input.requestId });
      if (memory.role === "representative" && !memory.authorizationCheckedThisTurn)
        return call("request_authorization", { turnId: input.requestId });
      return fauxAssistantMessage("Verification required.");
    }
    if (memory.phase === "RESOLVE_INTENT")
      return memory.clarification
        ? fauxAssistantMessage("Clarification required.")
        : call("resolve_case", { turnId: input.requestId });
    if (memory.phase === "PROCESS_CASE") {
      if (!memory.caseReadThisTurn) return call("read_case", { caseId: memory.selectedCaseId });
      if (confirmsCompletion(input))
        return call("complete_case", { confirmationTurnId: input.requestId });
      if (
        ["documents", "alternatives", "submission", "processing_time"].includes(
          memory.topic ?? "",
        ) &&
        !memory.guidanceReadThisTurn
      )
        return call("document_guidance", { caseId: memory.selectedCaseId, question: input.text });
      if (
        memory.topic === "alternatives" &&
        /none|no (copies|alternatives)|cannot (get|obtain)/i.test(input.text)
      )
        return call("handoff", { reason: "documents_unavailable" });
    }
    return fauxAssistantMessage("Confirmed facts are ready.");
  };
  return {
    provider: faux.provider,
    modelId: "scripted-insurance",
    apiKey: "demo-placeholder",
    beforeRun() {
      faux.setResponses(Array.from({ length: 32 }, () => response));
    },
  };
}

export function extractDemoFacts(text: string, collectIdentity = true): CallerFacts {
  const identity: Record<string, string> = {};
  const dob = collectIdentity ? dateOfBirthMentions(text)[0] : undefined;
  const name =
    text.match(
      /(?:my name is|name[: ]+)\s+([A-Za-z]+(?:[ -][A-Za-z]+){1,3})(?=[,.]|\s+(?:policy|and|my|dob)|$)/i,
    )?.[1] ??
    text.match(
      /(?:i am|i'm)\s+([A-Za-z]+(?:[ -][A-Za-z]+){1,3})(?=[,.]|\s+(?:policy|and|my|dob)|$)/i,
    )?.[1];
  if (collectIdentity) {
    if (name && !/policyholder|calling|the|angry/i.test(name)) identity.fullName = name;
    if (dob) identity.dateOfBirth = dob;
    const ssn = text.match(
      /(?:ssn(?: last (?:four|4))?|last (?:four|4))(?:\s+(?:is|digits|are))?[: ]+(\d{4})\b/i,
    )?.[1];
    if (ssn) identity.ssnLast4 = ssn;
    const email = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0];
    if (email) identity.email = email;
    const phone = text.match(
      /(?:phone|telephone)(?: number)?(?: is)?[: ]+(\+?\(?\d[\d ()-]{8,}\d)/i,
    )?.[1];
    if (phone) identity.phone = phone;
  }
  const policyNumber = text.match(/\bPOL-\d+\b/i)?.[0]?.toUpperCase();
  const caseId = text.match(/\bCL-\d+\b/i)?.[0]?.toUpperCase();
  const caseType = /healthcare|medical/i.test(text)
    ? ("healthcare" as const)
    : /\bauto\b|car claim/i.test(text)
      ? ("auto" as const)
      : /dental/i.test(text)
        ? ("dental" as const)
        : undefined;
  const month = (dob ? text.replace(dob, "") : text).match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
  )?.[0];
  const claimedStatus = /denied|denial/i.test(text)
    ? "denied"
    : /\bclosed\b/i.test(text)
      ? "closed"
      : /\bopen\b/i.test(text)
        ? "open"
        : undefined;
  const unrelated = /reinforcement learning|\bRL\b|weather|recipe|write (a |some )?code/i.test(
    text,
  );
  const inScope =
    /claim|insurance|denied|denial|document|report|note|policy/i.test(text) ||
    Object.keys(identity).length > 0;
  const topic = /how long|processing time/i.test(text)
    ? ("processing_time" as const)
    : /cannot|can't|missing|alternative|substitute/i.test(text)
      ? ("alternatives" as const)
      : /deadline|when.*(submit|send)|how soon/i.test(text)
        ? ("deadline" as const)
        : /where|how.*(submit|upload)|portal/i.test(text)
          ? ("submission" as const)
          : /amount|pay|reimburse|money/i.test(text)
            ? ("amounts" as const)
            : /document|report|note/i.test(text)
              ? ("documents" as const)
              : /denied|denial/i.test(text)
                ? ("denial" as const)
                : /claim|status/i.test(text)
                  ? ("status" as const)
                  : undefined;
  return {
    ...(Object.keys(identity).length ? { identity } : {}),
    ...(policyNumber ? { policyNumber } : {}),
    ...(/representative|on behalf|calling for my/i.test(text)
      ? { role: "representative" as const }
      : /policyholder/i.test(text)
        ? { role: "policyholder" as const }
        : {}),
    ...(caseId || caseType || month || claimedStatus
      ? {
          caseHints: {
            ...(caseId ? { caseId } : {}),
            ...(caseType ? { caseType } : {}),
            ...(month ? { month } : {}),
            ...(claimedStatus ? { claimedStatus } : {}),
          },
        }
      : {}),
    ...(topic
      ? {
          topic,
          intent:
            topic === "denial"
              ? ("denial_question" as const)
              : ["documents", "alternatives", "submission"].includes(topic)
                ? ("document_submission" as const)
                : ("status_inquiry" as const),
        }
      : {}),
    scope: unrelated ? (inScope ? "mixed" : "out_of_scope") : "in_scope",
    emotion: /refuse|won't|will not|don't want to|do not want to|not comfortable/i.test(text)
      ? "refusing"
      : /ridiculous|angry|frustrat|already told/i.test(text)
        ? "frustrated"
        : /worried|anxious|afraid/i.test(text)
          ? "anxious"
          : /confus/i.test(text)
            ? "confused"
            : "calm",
  };
}
