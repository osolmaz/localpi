import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { asObject, optionalString } from "../common/json.js";
import { listModels, normalizeBaseUrl } from "../llm/openai.js";
import type { ModelInfo } from "../llm/openai.js";
import {
  getManagedLlamaServerMetadata,
  getLlamaServerModels,
  llamaBaseUrl
} from "./llama-server.js";
import type { LocalpiOptions } from "./options.js";
import { listModelAliases, resolveLlamaModel } from "./models.js";

export type ModelAvailability = "loaded" | "startable";
export type ModelCapability = "text";
export type CatalogRuntime = "openai-compatible" | "managed-llama-server";

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
  readonly capabilities: readonly ModelCapability[];
  readonly availability: ModelAvailability;
};

export type ModelCatalog = {
  readonly models: readonly CatalogModel[];
  readonly warnings: readonly string[];
};

type ProviderConfig = {
  readonly id: string;
  readonly name: string;
  readonly type: "openai-compatible" | "managed-llama-server";
  readonly baseUrl?: string;
  readonly discover: boolean;
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
  if (config.baseUrl === undefined || !config.discover) {
    return { models: [], warnings: [] };
  }
  try {
    const models = await listModels(config.baseUrl, options.timeoutMs);
    return {
      models: models.map((model) => openAiCatalogModel(config, model, options)),
      warnings: []
    };
  } catch (error) {
    if (explicitProviderSelected(options, config.id)) {
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
    capabilities: ["text"],
    availability: "loaded",
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow })
  };
}

async function discoverManagedLlamaProvider(
  config: ProviderConfig,
  options: LocalpiOptions
): Promise<ModelCatalog> {
  const baseUrl = llamaBaseUrl(options);
  const loaded = await loadedLlamaModels(config, options, baseUrl);
  const startable = await startableLlamaModels(config, options, baseUrl, loaded.models);
  return {
    models: [...loaded.models, ...startable],
    warnings: loaded.warnings
  };
}

async function loadedLlamaModels(
  config: ProviderConfig,
  options: LocalpiOptions,
  baseUrl: string
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
        aliases: [],
        displayName: `${config.name} / ${model.id}`,
        maxTokens: options.maxTokens,
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
  loaded: readonly CatalogModel[]
): Promise<readonly CatalogModel[]> {
  const loadedIds = new Set(loaded.map((model) => model.modelId));
  const aliases = await listModelAliases();
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

async function providerConfigs(options: LocalpiOptions): Promise<readonly ProviderConfig[]> {
  switch (options.runtime) {
    case "auto":
      return dedupeProviderConfigs([
        lmStudioProvider(),
        vllmProvider(),
        ...(await configuredProviderConfigs(options)),
        managedLlamaProvider()
      ]);
    case "lmstudio":
      return [lmStudioProvider(options.baseUrl)];
    case "vllm":
      return [vllmProvider(options.baseUrl)];
    case "openai-compatible":
      return [
        {
          id: options.providerId,
          name: options.providerId,
          type: "openai-compatible",
          baseUrl: requiredBaseUrl(options),
          discover: true
        }
      ];
    case "llama-server":
      return [managedLlamaProvider()];
  }
}

function lmStudioProvider(baseUrl = "http://127.0.0.1:1234/v1"): ProviderConfig {
  return {
    id: "lmstudio",
    name: "LM Studio",
    type: "openai-compatible",
    baseUrl: normalizeBaseUrl(baseUrl),
    discover: true
  };
}

function vllmProvider(baseUrl = "http://127.0.0.1:8000/v1"): ProviderConfig {
  return {
    id: "vllm",
    name: "vLLM",
    type: "openai-compatible",
    baseUrl: normalizeBaseUrl(baseUrl),
    discover: true
  };
}

function managedLlamaProvider(): ProviderConfig {
  return {
    id: "llama-server",
    name: "llama-server",
    type: "managed-llama-server",
    discover: true
  };
}

async function configuredProviderConfigs(
  options: LocalpiOptions
): Promise<readonly ProviderConfig[]> {
  const configPath = configuredProvidersPath(options);
  if (configPath === undefined) {
    return [];
  }
  const raw = await readFile(expandHome(configPath), "utf8");
  const root = asObject(JSON.parse(raw) as unknown, "provider registry");
  const providers = root["providers"];
  if (providers === undefined) {
    return [];
  }
  return Object.entries(asObject(providers, "provider registry providers")).map(([id, value]) =>
    configuredProvider(id, value)
  );
}

function configuredProvider(id: string, value: unknown): ProviderConfig {
  const entry = asObject(value, `provider ${id}`);
  const type = optionalString(entry["type"]);
  if (type !== "openai-compatible") {
    throw new Error(`provider ${id} type must be openai-compatible`);
  }
  const baseUrl = optionalString(entry["baseUrl"]);
  if (baseUrl === undefined) {
    throw new Error(`provider ${id} must define baseUrl`);
  }
  return {
    id,
    name: optionalString(entry["name"]) ?? id,
    type,
    baseUrl: normalizeBaseUrl(baseUrl),
    discover: entry["discover"] !== false
  };
}

function configuredProvidersPath(options: LocalpiOptions): string | undefined {
  return options.providersFile ?? process.env["LOCALPI_MODELS_FILE"];
}

function dedupeProviderConfigs(configs: readonly ProviderConfig[]): readonly ProviderConfig[] {
  const byId = new Map<string, ProviderConfig>();
  for (const config of configs) {
    byId.set(config.id, config);
  }
  return [...byId.values()];
}

function explicitProviderSelected(options: LocalpiOptions, providerId: string): boolean {
  return options.provider === providerId;
}

function requiredBaseUrl(options: LocalpiOptions): string {
  if (options.baseUrl === undefined) {
    throw new Error("--runtime openai-compatible requires --base-url");
  }
  return options.baseUrl;
}

function expandHome(value: string): string {
  const home = os.homedir();
  return value === "~" || value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}
