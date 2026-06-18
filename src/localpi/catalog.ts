import { listModels } from "../llm/openai.js";
import type { ModelInfo } from "../llm/openai.js";
import {
  getManagedLlamaServerMetadata,
  getLlamaServerModels,
  llamaBaseUrl,
  managedLlamaServerUnavailableMessage
} from "./llama-server.js";
import type { LocalpiOptions } from "./options.js";
import { listModelAliases, resolveLlamaModel } from "./models.js";
import {
  loadLocalModelProfile,
  profileMatchesBaseUrl,
  profileMatchesModel,
  type LocalModelProfile
} from "./model-profile.js";
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
  readonly warnings: readonly CatalogWarning[];
};

export type CatalogWarningCode =
  | "provider-not-responding"
  | "managed-command-unavailable"
  | "runtime-warning";

export type CatalogWarning = {
  readonly providerId: string;
  readonly providerName: string;
  readonly code: CatalogWarningCode;
  readonly message: string;
};

export async function discoverModelCatalog(options: LocalpiOptions): Promise<ModelCatalog> {
  const configs = await providerConfigs(options);
  const profile = await loadLocalModelProfile(options);
  const discovered = await Promise.all(
    configs.map((config) => discoverProvider(config, options, profile))
  );
  return {
    models: discovered.flatMap((entry) => entry.models),
    warnings: discovered.flatMap((entry) => entry.warnings)
  };
}

async function discoverProvider(
  config: ProviderConfig,
  options: LocalpiOptions,
  profile?: LocalModelProfile
): Promise<ModelCatalog> {
  switch (config.type) {
    case "openai-compatible":
      return discoverOpenAiCompatibleProvider(config, options, profile);
    case "managed-llama-server":
      return discoverManagedLlamaProvider(config, options);
  }
}

async function discoverOpenAiCompatibleProvider(
  config: ProviderConfig,
  options: LocalpiOptions,
  profile?: LocalModelProfile
): Promise<ModelCatalog> {
  if (config.baseUrl === undefined) {
    return { models: [], warnings: [] };
  }
  if (!config.discover) {
    const explicitModel = explicitOpenAiCatalogModel(config, [], options, profile);
    return { models: explicitModel === undefined ? [] : [explicitModel], warnings: [] };
  }
  try {
    const models = await listModels(config.baseUrl, options.timeoutMs);
    const explicitModel = explicitOpenAiCatalogModel(config, models, options, profile);
    return {
      models:
        explicitModel === undefined
          ? models.map((model) => openAiCatalogModel(config, model, options, profile))
          : [explicitModel],
      warnings: []
    };
  } catch (error) {
    if (explicitOpenAiProviderSelected(options, config.id)) {
      throw error;
    }
    return {
      models: [],
      warnings: [
        catalogWarning(config.id, config.name, "provider-not-responding", {
          message: `not responding at ${config.baseUrl}`
        })
      ]
    };
  }
}

function openAiCatalogModel(
  config: ProviderConfig,
  model: ModelInfo,
  options: LocalpiOptions,
  profile?: LocalModelProfile
): CatalogModel {
  const baseUrl = config.baseUrl ?? "";
  const profileConfig = profileCapabilityConfig(profile, baseUrl, model.id);
  const aliases = profileAliases(profile, baseUrl, model.id);
  const contextWindow = profileConfig.contextWindow ?? model.contextWindow;
  return {
    providerId: config.id,
    providerName: config.name,
    runtime: "openai-compatible",
    baseUrl,
    modelId: model.id,
    aliases,
    displayName: `${config.name} / ${model.id}`,
    maxTokens: profileConfig.maxTokens ?? options.maxTokens,
    ...externalCapabilityConfig(config.id, model.id, profileConfig, options),
    capabilities: ["text"],
    availability: "loaded",
    ...(contextWindow === undefined ? {} : { contextWindow })
  };
}

function profileAliases(
  profile: LocalModelProfile | undefined,
  baseUrl: string,
  modelId: string
): readonly string[] {
  if (
    profile === undefined ||
    !profileMatchesBaseUrl(profile, baseUrl) ||
    !profileMatchesModel(profile, modelId)
  ) {
    return [];
  }
  return [profile.id, profile.model].filter(
    (alias, index, aliases) => alias !== modelId && aliases.indexOf(alias) === index
  );
}

function explicitOpenAiCatalogModel(
  config: ProviderConfig,
  models: readonly ModelInfo[],
  options: LocalpiOptions,
  profile?: LocalModelProfile
): CatalogModel | undefined {
  const requested = options.model;
  if (models.length !== 0 || requested === undefined || requested === "auto") {
    return undefined;
  }
  if (!explicitOpenAiProviderSelected(options, config.id)) {
    return undefined;
  }
  return openAiCatalogModel(config, { id: requested }, options, profile);
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
  const unavailableMessage = await managedLlamaServerUnavailableMessage(options);
  const startable = await startableLlamaModels(config, options, baseUrl, loaded.models, aliases);
  return {
    models: [...loaded.models, ...startable],
    warnings:
      unavailableMessage === undefined
        ? loaded.warnings
        : [
            ...loaded.warnings,
            catalogWarning(config.id, config.name, "managed-command-unavailable", {
              message: unavailableMessage
            })
          ]
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

function externalCapabilityConfig(
  providerId: string,
  modelId: string,
  profileConfig: ProfileCapabilityConfig,
  options: LocalpiOptions
): {
  readonly reasoning?: boolean;
  readonly thinkingFormat?: CatalogThinkingFormat;
} {
  const baseConfig =
    profileConfig.reasoning !== undefined || profileConfig.thinkingFormat !== undefined
      ? {
          reasoning: profileConfig.reasoning,
          thinkingFormat: profileConfig.thinkingFormat
        }
      : externalReasoningConfig(providerId, modelId);
  return withoutUndefined({
    reasoning: options.modelReasoning ?? baseConfig.reasoning,
    thinkingFormat: options.modelThinkingFormat ?? baseConfig.thinkingFormat
  });
}

function externalReasoningConfig(
  providerId: string,
  modelId: string
): {
  readonly reasoning?: true;
  readonly thinkingFormat?: CatalogThinkingFormat;
} {
  const normalized = modelId.toLowerCase();
  if (isDeepSeekThinkingModel(normalized)) {
    return { reasoning: true, thinkingFormat: "deepseek" };
  }
  if (isQwenThinkingModel(normalized)) {
    return { reasoning: true, thinkingFormat: "qwen-chat-template" };
  }
  if (providerId === "vllm" && isGemmaThinkingModel(normalized)) {
    return { reasoning: true, thinkingFormat: "qwen-chat-template" };
  }
  return {};
}

export function managedModelSupportsReasoning(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return (
    normalized.includes("reason") ||
    normalized.includes("thinking") ||
    isDeepSeekThinkingModel(normalized) ||
    isQwenThinkingModel(normalized) ||
    normalized.includes("gpt-oss") ||
    isGemmaThinkingModel(normalized)
  );
}

export function runtimeCatalogWarning(
  providerId: string,
  providerName: string,
  message: string
): CatalogWarning {
  return catalogWarning(providerId, providerName, "runtime-warning", { message });
}

export function formatCatalogWarning(warning: CatalogWarning): string {
  switch (warning.code) {
    case "provider-not-responding":
      return `${warning.providerName} is ${warning.message}`;
    case "managed-command-unavailable":
    case "runtime-warning":
      return warning.message;
  }
}

function catalogWarning(
  providerId: string,
  providerName: string,
  code: CatalogWarningCode,
  options: { readonly message: string }
): CatalogWarning {
  return {
    providerId,
    providerName,
    code,
    message: options.message
  };
}

function isDeepSeekThinkingModel(normalizedModelId: string): boolean {
  return (
    normalizedModelId.includes("deepseek") &&
    (hasModelToken(normalizedModelId, "r1") ||
      hasModelToken(normalizedModelId, "v4") ||
      hasModelToken(normalizedModelId, "4") ||
      normalizedModelId.includes("reason") ||
      normalizedModelId.includes("thinking"))
  );
}

function isQwenThinkingModel(normalizedModelId: string): boolean {
  const qwenThinkingMarkers = [
    "qwq",
    "qwen3",
    "qwen-3",
    "qwen_3",
    "qwen 3",
    "qwen4",
    "qwen-4",
    "qwen_4",
    "qwen 4"
  ];
  return (
    qwenThinkingMarkers.some((marker) => normalizedModelId.includes(marker)) ||
    (normalizedModelId.includes("qwen") &&
      (normalizedModelId.includes("reason") || normalizedModelId.includes("thinking")))
  );
}

type ProfileCapabilityConfig = {
  readonly reasoning?: boolean;
  readonly thinkingFormat?: CatalogThinkingFormat;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
};

function profileCapabilityConfig(
  profile: LocalModelProfile | undefined,
  baseUrl: string,
  modelId: string
): ProfileCapabilityConfig {
  if (
    profile === undefined ||
    !profileMatchesBaseUrl(profile, baseUrl) ||
    !profileMatchesModel(profile, modelId)
  ) {
    return {};
  }
  return withoutUndefined({
    reasoning: profile.capabilities?.reasoning,
    thinkingFormat: profile.capabilities?.thinkingFormat,
    contextWindow: profile.client?.contextWindow,
    maxTokens: profile.client?.maxTokens
  }) as ProfileCapabilityConfig;
}

function isGemmaThinkingModel(normalizedModelId: string): boolean {
  return normalizedModelId.includes("gemma-4") || normalizedModelId.includes("gemma4");
}

function hasModelToken(normalizedModelId: string, token: string): boolean {
  return normalizedModelId.split(/[^a-z0-9]+/u).includes(token);
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  ) as Partial<T>;
}
