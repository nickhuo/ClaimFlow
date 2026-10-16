import { resolve } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, type Provider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { registerBusinessTools, type BusinessTool } from "./tools.ts";

export interface SessionOptions {
  readonly cwd: string;
  readonly provider: Provider;
  readonly modelId: string;
  readonly apiKey: string;
  readonly systemPrompt: string;
  readonly tools?: readonly BusinessTool[];
}

/** Resources are supplied by this host only; no filesystem discovery or global Pi config. */
function createResources(systemPrompt: string): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
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
    thinkingLevel: "off",
    resourceLoader: createResources(options.systemPrompt),
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    }),
    noTools: "builtin",
    tools: registered.names,
    customTools: registered.tools,
  });
}
