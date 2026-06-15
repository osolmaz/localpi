import { listModels } from "../llm/openai.js";
import type { ModelInfo } from "../llm/openai.js";
import {
  getManagedLlamaServerMetadata,
  getLlamaServerModels,
  llamaBaseUrl
} from "./llama-server.js";
import type { LocalpiOptions } from "./options.js";
import { listModelAliases, resolveLlamaModel } from "./models.js";
import type { ProviderConfig } from "./provider-registry.js";
import { providerConfigs } from "./provider-registry.js";

export type ModelAvailability = "loaded" | "startable";
export type ModelCapability = "text";
export type CatalogRuntime = "openai-compatible" | "managed-llama-server";
export type CatalogThinkingFormat = "deepseek" | "qwen-chat-template";

export type CatalogModel = {
  readonly providerId: string;
  readonly providerName: string;
  readonly runtime: CatalogRuntime;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly aliases: readonly string[];
  readonly displayName: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly reasoning?: boolean;
  readonly thinkingFormat?: CatalogThinkingFormat;
  readonly capabilities: readonly ModelCapability[];
  readonly availability: ModelAvailability;
};

export type ModelCatalog = {
  readonly models: readonly CatalogModel[];
  readonly warnings: readonly string[];
};

export async function discoverModelCatalog(options: LocalpiOptions): Promise<ModelCatalog> {
  const configs = await providerConfigs(options);
  const discovered = await Promise.all(configs.map((config) => discoverProvider(config, options)));
  return {
    models: discovered.flatMap((entry) => entry.models),
    warnings: discovered.flatMap((entry) => entry.warnings)
  };
}

async function discoverProvider(
  config: ProviderConfig,
  options: LocalpiOptions
): Promise<ModelCatalog> {
  switch (config.type) {
    case "openai-compatible":
      return discoverOpenAiCompatibleProvider(config, options);
    case "managed-llama-server":
      return discoverManagedLlamaProvider(config, options);
  }
}

async function discoverOpenAiCompatibleProvider(
  config: ProviderConfig,
  options: LocalpiOptions
): Promise<ModelCatalog> {
  if (config.baseUrl === undefined) {
    return { models: [], warnings: [] };
  }
  if (!config.discover) {
    const explicitModel = explicitOpenAiCatalogModel(config, [], options);
    return { models: explicitModel === undefined ? [] : [explicitModel], warnings: [] };
  }
  try {
    const models = await listModels(config.baseUrl, options.timeoutMs);
    const explicitModel = explicitOpenAiCatalogModel(config, models, options);
    return {
      models:
        explicitModel === undefined
          ? models.map((model) => openAiCatalogModel(config, model, options))
          : [explicitModel],
      warnings: []
    };
  } catch (error) {
    if (explicitOpenAiProviderSelected(options, config.id)) {
      throw error;
    }
    return { models: [], warnings: [`${config.name} is not responding at ${config.baseUrl}`] };
  }
}

function openAiCatalogModel(
  config: ProviderConfig,
  model: ModelInfo,
  options: LocalpiOptions
): CatalogModel {
  const baseUrl = config.baseUrl ?? "";
  return {
    providerId: config.id,
    providerName: config.name,
    runtime: "openai-compatible",
    baseUrl,
    modelId: model.id,
    aliases: [],
    displayName: `${config.name} / ${model.id}`,
    maxTokens: options.maxTokens,
    ...externalReasoningConfig(model.id),
    capabilities: ["text"],
    availability: "loaded",
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow })
  };
}

function explicitOpenAiCatalogModel(
  config: ProviderConfig,
  models: readonly ModelInfo[],
  options: LocalpiOptions
): CatalogModel | undefined {
  const requested = options.model;
  if (models.length !== 0 || requested === undefined || requested === "auto") {
    return undefined;
  }
  if (!explicitOpenAiProviderSelected(options, config.id)) {
    return undefined;
  }
  return openAiCatalogModel(config, { id: requested }, options);
}

function explicitOpenAiProviderSelected(options: LocalpiOptions, providerId: string): boolean {
  return (
    options.provider === providerId ||
    (options.provider === undefined &&
      (options.runtime === "lmstudio" ||
        options.runtime === "vllm" ||
        options.runtime === "openai-compatible"))
  );
}

async function discoverManagedLlamaProvider(
  config: ProviderConfig,
  options: LocalpiOptions
): Promise<ModelCatalog> {
  const baseUrl = llamaBaseUrl(options);
  const aliases = await listModelAliases();
  const loaded = await loadedLlamaModels(config, options, baseUrl, aliases);
  const startable = await startableLlamaModels(config, options, baseUrl, loaded.models, aliases);
  return {
    models: [...loaded.models, ...startable],
    warnings: loaded.warnings
  };
}

async function loadedLlamaModels(
  config: ProviderConfig,
  options: LocalpiOptions,
  baseUrl: string,
  aliases: Awaited<ReturnType<typeof listModelAliases>>
): Promise<ModelCatalog> {
  const models = await getLlamaServerModels(options);
  if (models === undefined) {
    return { models: [], warnings: [] };
  }
  const managed = await getManagedLlamaServerMetadata(options);
  return {
    models: models.map((model): CatalogModel => {
      const contextWindow =
        model.contextWindow ?? (managed?.modelId === model.id ? managed.contextWindow : undefined);
      return {
        providerId: config.id,
        providerName: config.name,
        runtime: "managed-llama-server",
        baseUrl,
        modelId: model.id,
        aliases: aliases.filter((alias) => alias.id === model.id).map((alias) => alias.name),
        displayName: `${config.name} / ${model.id}`,
        maxTokens: options.maxTokens,
        reasoning: managedModelSupportsReasoning(model.id),
        capabilities: ["text"],
        availability: "loaded",
        ...(contextWindow === undefined ? {} : { contextWindow })
      };
    }),
    warnings: []
  };
}

async function startableLlamaModels(
  config: ProviderConfig,
  options: LocalpiOptions,
  baseUrl: string,
  loaded: readonly CatalogModel[],
  aliases: Awaited<ReturnType<typeof listModelAliases>>
): Promise<readonly CatalogModel[]> {
  const loadedIds = new Set(loaded.map((model) => model.modelId));
  const startable = await Promise.all(
    aliases.map(async (alias): Promise<CatalogModel | undefined> => {
      if (loadedIds.has(alias.id)) {
        return undefined;
      }
      try {
        const resolved = await resolveLlamaModel(alias.name, options.chatTemplate);
        return {
          providerId: config.id,
          providerName: config.name,
          runtime: "managed-llama-server" as const,
          baseUrl,
          modelId: resolved.id,
          aliases: [alias.name],
          displayName: `${config.name} / ${alias.name}`,
          maxTokens: options.maxTokens,
          reasoning: managedModelSupportsReasoning(resolved.id),
          capabilities: ["text"] as const,
          availability: "startable" as const,
          ...(resolved.contextWindow === undefined ? {} : { contextWindow: resolved.contextWindow })
        };
      } catch {
        return undefined;
      }
    })
  );
  return startable.filter((model): model is CatalogModel => model !== undefined);
}

function externalReasoningConfig(modelId: string): {
  readonly reasoning?: true;
  readonly thinkingFormat?: CatalogThinkingFormat;
} {
  const normalized = modelId.toLowerCase();
  if (normalized.includes("qwen")) {
    return { reasoning: true, thinkingFormat: "qwen-chat-template" };
  }
  if (normalized.includes("deepseek")) {
    return { reasoning: true, thinkingFormat: "deepseek" };
  }
  return {};
}

function managedModelSupportsReasoning(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return (
    normalized.includes("reason") ||
    normalized.includes("thinking") ||
    normalized.includes("deepseek") ||
    normalized.includes("qwen") ||
    normalized.includes("gpt-oss") ||
    normalized.includes("gemma-4")
  );
}
