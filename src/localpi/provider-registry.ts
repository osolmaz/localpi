import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { asObject, optionalString } from "../common/json.js";
import { normalizeBaseUrl } from "../llm/openai.js";
import { llamaBaseUrl } from "./llama-server.js";
import type { LocalpiOptions } from "./options.js";

export type ProviderType = "openai-compatible" | "managed-llama-server" | "llama-cpp";

export type ProviderConfig = {
  readonly id: string;
  readonly name: string;
  readonly type: ProviderType;
  readonly baseUrl?: string;
  readonly discover: boolean;
};

export async function providerConfigs(options: LocalpiOptions): Promise<readonly ProviderConfig[]> {
  switch (options.runtime) {
    case "auto":
      return autoProviderConfigs(options, await configuredProviderConfigs(options));
    case "lmstudio":
      return [lmStudioProvider(options.baseUrl)];
    case "vllm":
      return [vllmProvider(options.baseUrl)];
    case "llama-cpp":
      return [llamaCppProvider(options.baseUrl)];
    case "openai-compatible": {
      const providerId = options.provider ?? options.customProviderId;
      return [
        {
          id: providerId,
          name: providerId,
          type: "openai-compatible",
          baseUrl: requiredBaseUrl(options),
          discover: true
        }
      ];
    }
    case "llama-server":
      return [managedLlamaProvider()];
  }
}

function autoProviderConfigs(
  options: LocalpiOptions,
  configured: readonly ProviderConfig[]
): readonly ProviderConfig[] {
  const managedBaseUrl = llamaBaseUrl(options);
  return dedupeProviderConfigs([
    llamaCppProvider(),
    lmStudioProvider(),
    vllmProvider(),
    ...configured,
    managedLlamaProvider()
  ]).filter((config) => shouldProbeProvider(config, managedBaseUrl));
}

function shouldProbeProvider(config: ProviderConfig, managedBaseUrl: string): boolean {
  return (
    config.type === "managed-llama-server" ||
    config.baseUrl === undefined ||
    normalizeBaseUrl(config.baseUrl) !== managedBaseUrl
  );
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

function llamaCppProvider(baseUrl = defaultLlamaCppBaseUrl()): ProviderConfig {
  return {
    id: "llama-cpp",
    name: "llama.cpp",
    type: "llama-cpp",
    baseUrl: normalizeBaseUrl(baseUrl),
    discover: true
  };
}

// llama.cpp is localpi's default engine. Its endpoint is probed first so a loaded
// llama.cpp model wins the automatic selection ahead of other local engines.
export function defaultLlamaCppBaseUrl(): string {
  return "http://127.0.0.1:8080/v1";
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
  if (type !== "openai-compatible" && type !== "llama-cpp") {
    throw new Error(`provider ${id} type must be openai-compatible or llama-cpp`);
  }
  const baseUrl =
    optionalString(entry["baseUrl"]) ??
    (type === "llama-cpp" ? defaultLlamaCppBaseUrl() : undefined);
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
