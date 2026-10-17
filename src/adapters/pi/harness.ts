import type { Provider, ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  BUSINESS_TOOL_NAMES,
  PHASE_TOOLS,
  type BusinessToolContracts,
  type BusinessToolName,
} from "../../application/tool-contracts.ts";
import type {
  ConversationHarness,
  HarnessFactory,
  HarnessRun,
  PublicEvent,
} from "../../application/session-ports.ts";
import { SYSTEM_PROMPT } from "../../application/conversation/prompt.ts";
import { RuleViolation, type Phase } from "../../domain/conversation.ts";
import { createSession } from "./session-factory.ts";
import { defineBusinessTool } from "./tools.ts";

export interface ProviderConfiguration {
  readonly provider: Provider;
  readonly modelId: string;
  readonly apiKey: string;
  readonly thinkingLevel?: ThinkingLevel | "off";
  readonly beforeRun?: () => void;
}
const activities: Record<BusinessToolName, Extract<PublicEvent, { type: "progress" }>["activity"]> =
  {
    record_facts: "preparing",
    verify_identity: "verifying",
    request_authorization: "authorization",
    resolve_case: "locating",
    read_case: "reading",
    document_guidance: "reading",
    complete_case: "preparing",
    set_email_consent: "preparing",
    send_summary: "sending",
    resume_case: "reading",
    handoff: "handoff",
  };
export interface PiObservation {
  readonly type: string;
  readonly tool?: string;
  readonly projectionCharacters?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly estimatedCostUsd?: number | null;
}

export function piHarnessFactory(options: {
  readonly cwd: string;
  readonly provider: () => ProviderConfiguration;
  readonly retry?: {
    readonly enabled: boolean;
    readonly maxRetries: number;
    readonly baseDelayMs: number;
  };
  readonly trace?: (event: PiObservation) => void;
}): HarnessFactory {
  const trace = (event: PiObservation) => {
    try {
      options.trace?.(event);
    } catch {
      /* Diagnostics cannot alter a run. */
    }
  };
  return {
    async create(): Promise<ConversationHarness> {
      const config = options.provider();
      let current: HarnessRun | null = null;
      let requests = 0;
      let toolCalls = 0;
      let limited = false;
      let disposed = false;
      let session: AgentSession | undefined;
      const run = () => {
        if (!current || disposed) throw new RuleViolation("cancelled");
        current.signal.throwIfAborted();
        return current;
      };
      const makeTool = <Name extends BusinessToolName>(name: Name) =>
        defineBusinessTool({
          name,
          label: name.replaceAll("_", " "),
          description: `Insurance business operation ${name}. Current SOP guards always apply.`,
          authorize: async (args) => {
            await run().authorize(name, args);
          },
          async execute(args) {
            const active = run();
            await active.authorize(name, args);
            await active.onProgress(activities[name]);
            const output = await active.execute(name, args);
            run();
            return output as BusinessToolContracts[Name]["output"];
          },
        });
      const businessTools = BUSINESS_TOOL_NAMES.map(makeTool);
      const created = await createSession({
        cwd: options.cwd,
        provider: config.provider,
        modelId: config.modelId,
        apiKey: config.apiKey,
        systemPrompt: SYSTEM_PROMPT,
        ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
        tools: businessTools,
        ...(options.retry ? { retry: options.retry } : {}),
        hooks: {
          authorize: async (name, args) => {
            if (++toolCalls > 24) {
              limited = true;
              void session?.abort();
              throw new RuleViolation("run_limit");
            }
            try {
              await run().authorize(name, args);
            } catch (error) {
              trace({
                type: "tool_blocked",
                ...(BUSINESS_TOOL_NAMES.includes(name as BusinessToolName) ? { tool: name } : {}),
              });
              throw error;
            }
          },
          context: async () => {
            try {
              const active = run();
              if (++requests > 12) {
                limited = true;
                void session?.abort();
              }
              const projection = await active.context();
              trace({
                type: "model_request",
                projectionCharacters: projection.length + active.input.text.length,
              });
              const state = JSON.parse(projection) as {
                phase: Phase;
                status: string;
                availableTools: BusinessToolName[];
              };
              const activeTools =
                state.status === "handoff_requested"
                  ? []
                  : PHASE_TOOLS[state.phase].filter((name) => state.availableTools.includes(name));
              // Explicit projection prevents stale transcripts, compaction, and tool results from becoming authority.
              // Pi 1.3 carries prompts and tool declarations in system messages, so replacing history must retain both.
              // Keep guarded implementations registered: changing SDK executability here takes effect one turn later.
              return [
                {
                  role: "system",
                  content: SYSTEM_PROMPT,
                  toolsRemoved: BUSINESS_TOOL_NAMES.filter(
                    (name) => !activeTools.includes(name),
                  ).map((name) => ({ name })),
                  toolsAdded: businessTools
                    .filter((tool) => activeTools.includes(tool.name))
                    .map(({ name, description, parameters }) => ({
                      name,
                      description,
                      parameters,
                    })),
                  timestamp: Date.now(),
                },
                {
                  role: "user",
                  content: JSON.stringify({
                    callerTurn: active.input,
                    authoritativeMemory: JSON.parse(projection),
                  }),
                  timestamp: Date.now(),
                },
              ];
            } catch {
              void session?.abort();
              return [
                {
                  role: "user",
                  content: "This business session is no longer available. Stop.",
                  timestamp: Date.now(),
                },
              ];
            }
          },
        },
      });
      session = created.session;
      await session.bindExtensions({});
      return {
        async run(active) {
          if (current || disposed) throw new RuleViolation("run_in_progress");
          current = active;
          requests = 0;
          toolCalls = 0;
          limited = false;
          config.beforeRun?.();
          let failed = false;
          const unsubscribe = session!.subscribe((event) => {
            // Trace vocabulary contains no text, arguments, results, thinking, PII or provider diagnostics.
            trace({
              type: event.type,
              ...("toolName" in event &&
              BUSINESS_TOOL_NAMES.includes(event.toolName as BusinessToolName)
                ? { tool: event.toolName as string }
                : {}),
            });
            if (event.type === "message_end" && event.message.role === "assistant") {
              failed = ["error", "aborted"].includes(event.message.stopReason);
              const usage = event.message.usage;
              trace({
                type: "model_usage",
                inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
                outputTokens: usage.output,
                cachedTokens: usage.cacheRead,
                cacheWriteTokens: usage.cacheWrite,
                estimatedCostUsd: usage.cost.total > 0 ? usage.cost.total : null,
              });
            }
          });
          const abort = () => {
            void session!.abort();
          };
          active.signal.addEventListener("abort", abort, { once: true });
          try {
            active.signal.throwIfAborted();
            await session!.prompt(
              JSON.stringify({ requestId: active.input.requestId, text: active.input.text }),
              { expandPromptTemplates: false },
            );
            active.signal.throwIfAborted();
            if (limited) throw new RuleViolation("run_limit");
            if (failed) throw new RuleViolation("model_unavailable");
          } finally {
            active.signal.removeEventListener("abort", abort);
            unsubscribe();
            current = null;
          }
        },
        async close() {
          if (!disposed) {
            disposed = true;
            await session!.abort();
            session!.dispose();
          }
        },
      };
    },
  };
}
