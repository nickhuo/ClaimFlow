import {
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import type { ProviderConfiguration } from "./harness.ts";

/** Resolve only explicitly configured credentials and one provider/model. No ambient login or discovery. */
export function modelConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): ProviderConfiguration {
  const id = env.MODEL_PROVIDER?.trim();
  const modelId = env.MODEL_ID?.trim();
  const apiKey = env.MODEL_API_KEY?.trim();
  if (!id || !modelId || !apiKey)
    throw new Error(
      "Configure MODEL_PROVIDER, MODEL_ID and MODEL_API_KEY, or explicitly set AGENT_MODE=demo.",
    );
  if (!["openai", "anthropic", "openai-compatible"].includes(id))
    throw new Error("MODEL_PROVIDER must be openai, anthropic or openai-compatible.");
  const native: Provider | undefined =
    id === "openai" ? openaiProvider() : id === "anthropic" ? anthropicProvider() : undefined;
  const baseUrl = env.MODEL_BASE_URL?.trim() || native?.baseUrl;
  if (!baseUrl) throw new Error("MODEL_BASE_URL is required for openai-compatible.");
  try {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error();
  } catch {
    throw new Error("MODEL_BASE_URL must be an HTTP(S) URL without embedded credentials.");
  }
  const known = native?.getModels().find((model) => model.id === modelId);
  if (native && !known)
    throw new Error(
      "MODEL_ID is not in the pinned SDK provider catalog. Use openai-compatible for a custom compatible model.",
    );
  const model: Model<Api> = known
    ? { ...known, baseUrl }
    : {
        id: modelId,
        name: modelId,
        provider: id,
        api: "openai-completions",
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 4096,
      };
  const provider = createProvider({
    id,
    baseUrl,
    auth: { apiKey: envApiKeyAuth("Explicit server API key", []) },
    models: [model],
    api:
      id === "anthropic"
        ? anthropicMessagesApi()
        : id === "openai"
          ? openAIResponsesApi()
          : openAICompletionsApi(),
  });
  return { provider, modelId, apiKey, thinkingLevel: model.reasoning ? "low" : "off" };
}
