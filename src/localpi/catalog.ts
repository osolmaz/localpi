import { fetchServerProps, listModels, probeThinkingSwitch } from "../llm/openai.js";
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
export type ModelCapability = "text" | "image";
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
    case "llama-cpp":
      return discoverLlamaCppProvider(config, options, profile);
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
  profile?: LocalModelProfile,
  availability: ModelAvailability = "loaded",
  thinkingSwitch?: boolean
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
    ...thinkingConfig(profileConfig, thinkingSwitch, options),
    capabilities: modelCapabilities(model, profileConfig),
    availability,
    ...(contextWindow === undefined ? {} : { contextWindow })
  };
}

async function discoverLlamaCppProvider(
  config: ProviderConfig,
  options: LocalpiOptions,
  profile?: LocalModelProfile
): Promise<ModelCatalog> {
  const baseUrl = config.baseUrl;
  if (baseUrl === undefined) {
    return { models: [], warnings: [] };
  }
  if (!config.discover) {
    const explicitModel = explicitOpenAiCatalogModel(config, [], options, profile);
    return { models: explicitModel === undefined ? [] : [explicitModel], warnings: [] };
  }
  let models: readonly ModelInfo[];
  try {
    models = await listModels(baseUrl, options.timeoutMs);
  } catch (error) {
    if (explicitOpenAiProviderSelected(options, config.id)) {
      throw error;
    }
    return {
      models: [],
      warnings: [
        catalogWarning(config.id, config.name, "provider-not-responding", {
          message: `not responding at ${baseUrl}`
        })
      ]
    };
  }
  const loaded = models.filter((model) => model.status !== "unloaded");
  const unloaded = models.filter((model) => model.status === "unloaded");
  const autoload = await llamaCppAutoload(baseUrl, options);
  const startable = autoload === true ? unloaded : [];
  // Only a loaded model can render its template, so an unloaded one stays unknown.
  const switches = await probeThinkingSwitches(
    baseUrl,
    loaded.map((model) => model.id),
    options.timeoutMs
  );
  return {
    models: [
      ...loaded.map((model) =>
        openAiCatalogModel(config, model, options, profile, "loaded", switches.get(model.id))
      ),
      ...startable.map((model) => openAiCatalogModel(config, model, options, profile, "startable"))
    ],
    warnings: llamaCppUnloadedWarnings(config, unloaded, autoload)
  };
}

// Pi passes image input to a model only when the model catalog says the model takes images. A
// llama.cpp server reports that in the model architecture, and a model profile can state it for a
// server that reports nothing. No model name is used to guess it.
function modelCapabilities(
  model: ModelInfo,
  profileConfig: ProfileCapabilityConfig
): readonly ModelCapability[] {
  const image = profileConfig.image ?? model.inputModalities?.includes("image") === true;
  return image ? ["text", "image"] : ["text"];
}

async function llamaCppAutoload(
  baseUrl: string,
  options: LocalpiOptions
): Promise<boolean | undefined> {
  try {
    return (await fetchServerProps(baseUrl, options.timeoutMs)).modelsAutoload;
  } catch {
    return undefined;
  }
}

function llamaCppUnloadedWarnings(
  config: ProviderConfig,
  unloaded: readonly ModelInfo[],
  autoload: boolean | undefined
): readonly CatalogWarning[] {
  if (unloaded.length === 0 || autoload === true) {
    return [];
  }
  return [
    catalogWarning(config.id, config.name, "runtime-warning", {
      message: `${config.name} reported unloaded models: ${unloaded
        .map((model) => model.id)
        .join(", ")}; the server does not autoload models`
    })
  ];
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
  return openAiCatalogModel(
    config,
    { id: explicitProfileModelId(profile, config.baseUrl ?? "", requested) },
    options,
    profile
  );
}

function explicitProfileModelId(
  profile: LocalModelProfile | undefined,
  baseUrl: string,
  requested: string
): string {
  if (
    profile !== undefined &&
    profileMatchesBaseUrl(profile, baseUrl) &&
    profileMatchesModel(profile, requested)
  ) {
    return profile.model;
  }
  return requested;
}

function explicitOpenAiProviderSelected(options: LocalpiOptions, providerId: string): boolean {
  return (
    options.provider === providerId ||
    (options.provider === undefined &&
      (options.runtime === "lmstudio" ||
        options.runtime === "vllm" ||
        options.runtime === "llama-cpp" ||
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
  const switches = await probeThinkingSwitches(
    baseUrl,
    models.map((model) => model.id),
    options.timeoutMs
  );
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
        ...thinkingConfig({}, switches.get(model.id), options),
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
          ...thinkingConfig({}, undefined, options),
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

/**
 * Thinking controls for one model. The sources, strongest first: the command-line flags, the model
 * profile, then what the server reports. A llama.cpp server reports through the thinking-switch
 * probe; other engines report nothing, so a profile declares their thinking. When no source says
 * anything, the model gets no thinking controls. A model name is never used to guess.
 *
 * Pi's `qwen-chat-template` format sends `chat_template_kwargs.enable_thinking`. Despite the name,
 * that is llama.cpp's generic switch: the server applies `enable_thinking` to any chat template,
 * and the probe has just shown that this model's template honors it.
 */
function thinkingConfig(
  profileConfig: ProfileCapabilityConfig,
  thinkingSwitch: boolean | undefined,
  options: LocalpiOptions
): {
  readonly reasoning?: boolean;
  readonly thinkingFormat?: CatalogThinkingFormat;
} {
  const reported = thinkingSwitch === true;
  return withoutUndefined({
    reasoning: options.modelReasoning ?? profileConfig.reasoning ?? (reported ? true : undefined),
    thinkingFormat:
      options.modelThinkingFormat ??
      profileConfig.thinkingFormat ??
      (reported ? ("qwen-chat-template" as const) : undefined)
  }) as { readonly reasoning?: boolean; readonly thinkingFormat?: CatalogThinkingFormat };
}

/**
 * Thinking controls for a llama-server model: the flags, then the thinking-switch probe. Pass no
 * probe result for a model that has not started yet. The managed server also gets
 * `--reasoning on|off` from `--thinking`, so its thinking follows the flag on the server side too.
 */
export function llamaServerThinkingConfig(
  options: LocalpiOptions,
  thinkingSwitch?: boolean
): {
  readonly reasoning?: boolean;
  readonly thinkingFormat?: CatalogThinkingFormat;
} {
  return thinkingConfig({}, thinkingSwitch, options);
}

/** Probe each model's thinking switch, keyed by model id. */
export async function probeThinkingSwitches(
  baseUrl: string,
  modelIds: readonly string[],
  timeoutMs: number
): Promise<ReadonlyMap<string, boolean | undefined>> {
  const switches = await Promise.all(
    modelIds.map((modelId) => probeThinkingSwitch(baseUrl, modelId, timeoutMs))
  );
  return new Map(modelIds.map((modelId, index) => [modelId, switches[index]]));
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

type ProfileCapabilityConfig = {
  readonly reasoning?: boolean;
  readonly image?: boolean;
  readonly thinkingFormat?: CatalogThinkingFormat;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
};

function profileApplies(
  profile: LocalModelProfile | undefined,
  baseUrl: string,
  modelId: string
): profile is LocalModelProfile {
  return (
    profile !== undefined &&
    profileMatchesBaseUrl(profile, baseUrl) &&
    profileMatchesModel(profile, modelId)
  );
}

function profileCapabilityConfig(
  profile: LocalModelProfile | undefined,
  baseUrl: string,
  modelId: string
): ProfileCapabilityConfig {
  if (!profileApplies(profile, baseUrl, modelId)) {
    return {};
  }
  return withoutUndefined({
    reasoning: profile.capabilities?.reasoning,
    image: profile.capabilities?.image,
    thinkingFormat: profile.capabilities?.thinkingFormat,
    contextWindow: profile.client?.contextWindow,
    maxTokens: profile.client?.maxTokens
  }) as ProfileCapabilityConfig;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  ) as Partial<T>;
}
