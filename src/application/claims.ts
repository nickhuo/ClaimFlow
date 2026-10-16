import { collectedFacts, RuleViolation } from "../domain/conversation.ts";
import type { BusinessContext } from "./conversation/context.ts";

export async function readCase(context: BusinessContext, caseId: string) {
  const subjectId = context.subject();
  if (context.read().state.selectedCase?.value.caseId !== caseId)
    throw new RuleViolation("case_unavailable");
  const record = await context.dependencies.data.getCase(subjectId, caseId);
  if (context.subject() !== subjectId || !record || record.value.subjectId !== subjectId)
    throw new RuleViolation("case_unavailable");
  const fact = {
    ...record,
    origin: "tool" as const,
    toolName: "read_case",
    operationId: context.input.requestId,
  };
  const facts = collectedFacts(context.read().state);
  context.commit({
    type: "case_read",
    fact,
    topic: facts.topic ?? (facts.intent === "denial_question" ? "denial" : "status"),
  });
  return fact;
}
