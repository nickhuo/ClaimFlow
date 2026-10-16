import { collectedFacts } from "../domain/conversation.ts";
import { matchingCases } from "../domain/claims.ts";
import type { BusinessContext } from "./conversation/context.ts";

export async function resolveCase(context: BusinessContext) {
  const subjectId = context.subject();
  const facts = collectedFacts(context.read().state);
  const clarify = (question: string) => {
    context.clarification = question;
    return { status: "needs_clarification" as const, question };
  };
  if (!facts.intent)
    return clarify(
      "What would you like help with: a claim status, a denial, or the requested documents?",
    );
  const candidates = await context.dependencies.data.listCases(subjectId);
  context.subject();
  const matches = matchingCases(
    candidates.map((entry) => entry.value),
    {
      ...facts.caseHints,
      // A denial inquiry narrows the search; this is a caller hint, never a claim-status fact.
      ...(!facts.caseHints?.caseId &&
      !facts.caseHints?.claimedStatus &&
      facts.intent === "denial_question"
        ? { claimedStatus: "denied" }
        : {}),
    },
  );
  if (!matches.length)
    return clarify(
      "I couldn't locate a matching claim in your authorized records. Please check the claim number, type, or month.",
    );
  if (matches.length > 1)
    return clarify(
      `Which claim do you mean? ${matches.map((item) => `${item.caseId} · ${item.caseType} · ${item.createdAt} · ${item.status}`).join("; ")}`,
    );
  const selected = candidates.find((entry) => entry.value.caseId === matches[0]?.caseId)!;
  const fact = {
    origin: "tool" as const,
    toolName: "resolve_case",
    operationId: context.input.requestId,
    observedAt: selected.observedAt,
    sources: selected.sources,
    value: { subjectId, caseId: selected.value.caseId },
  };
  context.commit({ type: "case_selected", fact });
  return { status: "selected" as const, case: fact };
}
