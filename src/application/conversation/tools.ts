import { Check } from "typebox/value";
import { collectedFacts, RuleViolation } from "../../domain/conversation.ts";
import {
  BUSINESS_TOOL_SCHEMAS,
  PHASE_TOOLS,
  type BusinessToolContracts,
  type BusinessToolName,
} from "../tool-contracts.ts";
import { verifyIdentity, requireOriginatingTurn } from "../identity.ts";
import { requestAuthorization } from "../authorization.ts";
import { resolveCase } from "../resolve-case.ts";
import { readCase } from "../claims.ts";
import { documentGuidance } from "../documents.ts";
import { completeCase, sendSummary, setEmailConsent } from "../follow-up.ts";
import { groundCallerFacts, requestsHuman } from "./user-turn.ts";
import type { BusinessContext } from "./context.ts";
import { observe } from "../telemetry.ts";

export class BusinessOperations {
  #steps = 0;
  constructor(readonly context: BusinessContext) {}
  async authorize(name: string, raw: unknown): Promise<void> {
    const { state } = await this.context.read();
    if (!Object.hasOwn(BUSINESS_TOOL_SCHEMAS, name)) throw new RuleViolation("unknown_tool");
    const key = name as BusinessToolName;
    if (!Check(BUSINESS_TOOL_SCHEMAS[key].input, raw))
      throw new RuleViolation("invalid_tool_input");
    if (!(PHASE_TOOLS[state.phase] as readonly string[]).includes(name))
      throw new RuleViolation("action_not_available");
    if (state.status === "handoff_requested") throw new RuleViolation("handoff_requested");
    if (state.status === "completed" && !["resume_case", "send_summary", "handoff"].includes(name))
      throw new RuleViolation("conversation_completed");
    if (
      [
        "resolve_case",
        "read_case",
        "document_guidance",
        "complete_case",
        "set_email_consent",
        "send_summary",
        "resume_case",
      ].includes(name)
    )
      await this.context.subject();
    if (name === "read_case" || name === "document_guidance") {
      if ((raw as { caseId: string }).caseId !== state.selectedCase?.value.caseId)
        throw new RuleViolation("case_unavailable");
    }
  }
  async execute(name: string, raw: unknown): Promise<unknown> {
    const { state } = await this.context.read();
    let verified = false;
    try {
      await this.context.subject();
      verified = true;
    } catch {
      /* Protected operations still enforce the gate below. */
    }
    const snapshot = {
      tool: Object.hasOwn(BUSINESS_TOOL_SCHEMAS, name)
        ? (name as BusinessToolName)
        : ("unknown" as const),
      phase: state.phase,
      verified,
      currentEmailConsent:
        state.emailConsent.status === "granted" &&
        state.emailConsent.confirmationTurnId === this.context.input.requestId,
    };
    try {
      const result = await this.#execute(name, raw);
      this.context.operations.push({ tool: snapshot.tool, outcome: "success", reason: null });
      observe(this.context.dependencies.observe, {
        type: "tool_outcome",
        ...snapshot,
        outcome: "success",
        reason: null,
      });
      return result;
    } catch (error) {
      this.context.operations.push({
        tool: snapshot.tool,
        outcome: error instanceof RuleViolation ? "denied" : "error",
        reason: error instanceof RuleViolation ? error.code : "operation_failed",
      });
      observe(this.context.dependencies.observe, {
        type: "tool_outcome",
        ...snapshot,
        outcome: error instanceof RuleViolation ? "denied" : "error",
        reason: error instanceof RuleViolation ? error.code : "operation_failed",
      });
      throw error;
    }
  }
  async #execute(name: string, raw: unknown): Promise<unknown> {
    await this.authorize(name, raw);
    if (++this.#steps > 24) throw new RuleViolation("run_limit");
    const input = <Name extends BusinessToolName>(_name: Name) =>
      raw as BusinessToolContracts[Name]["input"];
    const context = this.context;
    switch (name as BusinessToolName) {
      case "record_facts": {
        const args = input("record_facts");
        requireOriginatingTurn(context, args.turnId);
        const facts = groundCallerFacts(args.facts, context.input);
        context.clarification = null;
        await context.commit({ type: "record", turnId: args.turnId, facts });
        return { recorded: true };
      }
      case "verify_identity":
        requireOriginatingTurn(context, input("verify_identity").turnId);
        return verifyIdentity(context);
      case "request_authorization":
        requireOriginatingTurn(context, input("request_authorization").turnId);
        return requestAuthorization(context);
      case "resolve_case":
        requireOriginatingTurn(context, input("resolve_case").turnId);
        return resolveCase(context);
      case "read_case":
        return readCase(context, input("read_case").caseId);
      case "document_guidance":
        return documentGuidance(context, input("document_guidance").caseId);
      case "complete_case":
        requireOriginatingTurn(context, input("complete_case").confirmationTurnId);
        return completeCase(context);
      case "set_email_consent": {
        const args = input("set_email_consent");
        requireOriginatingTurn(context, args.confirmationTurnId);
        return setEmailConsent(context, args.decision, args.summaryVersion);
      }
      case "send_summary":
        return sendSummary(context, input("send_summary").summaryVersion);
      case "resume_case":
        requireOriginatingTurn(context, input("resume_case").turnId);
        await context.commit({ type: "resume" });
        return { phase: "PROCESS_CASE" };
      case "handoff": {
        const { reason } = input("handoff");
        const state = (await context.read()).state;
        const supported =
          reason === "caller_request"
            ? requestsHuman(context.input)
            : reason === "documents_unavailable"
              ? Boolean(
                  state.guidance &&
                  collectedFacts(state).topic === "alternatives" &&
                  /none|cannot|can't|unavailable/i.test(context.input.text),
                )
              : reason === "authorization_missing"
                ? collectedFacts(state).role === "representative"
                : reason === "authorization_timeout"
                  ? state.representativeAuthorization.status === "pending" &&
                    context.dependencies.clock.now() >=
                      state.representativeAuthorization.requestedAt +
                        context.dependencies.policy.authorizationTimeoutMs
                  : reason === "identity_failures"
                    ? state.identityFailures >= context.dependencies.policy.maxIdentityFailures
                    : reason === "identity_refusal"
                      ? state.consecutiveIdentityRefusals >=
                        context.dependencies.policy.maxIdentityFailures
                      : reason === "repeated_off_topic"
                        ? state.consecutiveOffTopic >=
                          context.dependencies.policy.maxConsecutiveOffTopic
                        : false;
        if (!supported) throw new RuleViolation("handoff_reason_not_confirmed");
        await context.commit({ type: "handoff", reason });
        return { status: "requested" };
      }
    }
  }
}
