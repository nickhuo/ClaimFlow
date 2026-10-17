import { collectedFacts, RuleViolation } from "../domain/conversation.ts";
import type { BusinessContext } from "./conversation/context.ts";

export async function documentGuidance(context: BusinessContext, caseId: string) {
  const subjectId = await context.subject();
  const { state } = await context.read();
  if (state.selectedCase?.value.caseId !== caseId || !state.caseFacts)
    throw new RuleViolation("case_unavailable");
  const record = await context.dependencies.data.getDocumentGuidance(subjectId, caseId);
  if ((await context.subject()) !== subjectId || !record)
    throw new RuleViolation("case_unavailable");
  const guidance = record.value;
  const topic = collectedFacts(state).topic;
  let text: string;
  if (topic === "processing_time")
    text = `The general processing estimate after receiving complete documents is ${guidance.processingTimeEstimate.value}. It is an estimate, not a guaranteed decision or approval.`;
  else if (topic === "submission") text = guidance.general.value;
  else if (guidance.documents === null)
    text =
      "The claim record does not specify which documents are required. A human representative can clarify the request.";
  else if (guidance.documents.length === 0)
    text = "The claim record lists no outstanding documents.";
  else
    text =
      guidance.documents
        .map((document) => {
          const explanation =
            topic === "alternatives"
              ? document.alternatives.value
              : (document.guidance?.value ??
                "No document-specific instructions are available; please ask a human representative to confirm the requirements.");
          const original =
            document.originalRequirement === "required"
              ? "The claim explicitly requires an original."
              : "The claim does not specify an original requirement.";
          return `${document.requestedName}: ${explanation} ${original}`;
        })
        .join("\n\n") +
      (topic === "alternatives"
        ? "\n\nThese are general options for review; acceptance of a substitute has not been confirmed."
        : `\n\n${guidance.general.value}`);
  const fact = {
    ...record,
    value: { guidance: text },
    origin: "tool" as const,
    toolName: "document_guidance",
    operationId: context.input.requestId,
  };
  await context.commit({ type: "guidance_read", fact });
  return fact;
}
