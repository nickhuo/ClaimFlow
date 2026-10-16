import { resolve } from "node:path";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Provider,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  createSyntheticSourceInfo,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ContextEvent,
  type Extension,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { registerBusinessTools, type BusinessTool } from "./tools.ts";

export interface SessionOptions {
  readonly cwd: string;
  readonly provider: Provider;
  readonly modelId: string;
  readonly apiKey: string;
  readonly systemPrompt: string;
  readonly thinkingLevel?: ThinkingLevel | "off";
  readonly tools?: readonly BusinessTool[];
  readonly hooks?: {
    readonly context: (event: ContextEvent) => ContextEvent["messages"];
    readonly authorize: (name: string, input: unknown) => void;
  };
  readonly retry?: {
    readonly enabled: boolean;
    readonly maxRetries: number;
    readonly baseDelayMs: number;
  };
}

/** Resources are supplied by this host only; no filesystem discovery or global Pi config. */
function createResources(systemPrompt: string, hooks?: SessionOptions["hooks"]): ResourceLoader {
  const runtime = createExtensionRuntime();
  const extension: Extension = {
    path: "<inline:business-policy>",
    resolvedPath: "<inline:business-policy>",
    sourceInfo: createSyntheticSourceInfo("<inline:business-policy>", { source: "inline" }),
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
  if (hooks) {
    extension.handlers.set("context", [
      async (event) => ({ messages: hooks.context(event as ContextEvent) }),
    ]);
    extension.handlers.set("tool_call", [
      async (raw) => {
        const event = raw as ToolCallEvent;
        try {
          hooks.authorize(event.toolName, event.input);
        } catch {
          return {
            block: true,
            reason: "This action is not permitted by the current business state.",
          };
        }
        return undefined;
      },
    ]);
  }
  return {
    getExtensions: () => ({ extensions: hooks ? [extension] : [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/** One customer conversation per call. Pi owns the loop; callers own the lifecycle. */
export async function createSession(options: SessionOptions) {
  if (!options.apiKey.trim()) throw new Error("An explicit provider API key is required");
  if (!options.systemPrompt.trim()) throw new Error("An explicit system prompt is required");
  const cwd = resolve(options.cwd);
  const registered = registerBusinessTools(options.tools ?? []);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(options.provider);
  await modelRuntime.setRuntimeApiKey(options.provider.id, options.apiKey);
  const model = modelRuntime.getModel(options.provider.id, options.modelId);
  if (!model) throw new Error("The requested model is not registered on the supplied provider");

  return createAgentSession({
    cwd,
    agentDir: resolve(cwd, ".data/pi"),
    modelRuntime,
    model,
    thinkingLevel: options.thinkingLevel ?? "off",
    resourceLoader: createResources(options.systemPrompt, options.hooks),
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: options.retry ?? { enabled: false },
      cacheWarming: "off",
    }),
    noTools: "builtin",
    tools: registered.names,
    customTools: registered.tools,
  });
}
