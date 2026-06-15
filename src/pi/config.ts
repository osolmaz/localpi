import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CatalogModel } from "../localpi/catalog.js";
import type { LocalpiOptions } from "../localpi/options.js";
import type { RuntimeConnection } from "../localpi/runtime.js";

export type RuntimeConfig = {
  readonly configDir: string;
  readonly modelsPath: string;
  readonly settingsPath: string;
};

export async function writeRuntimeConfig(
  options: LocalpiOptions,
  connection: RuntimeConnection
): Promise<RuntimeConfig> {
  const configDir = path.join(options.stateDir, "pi-config-runtime");
  await mkdir(configDir, { recursive: true });
  const modelsPath = path.join(configDir, "models.json");
  const settingsPath = path.join(configDir, "settings.json");
  await writeFile(modelsPath, `${JSON.stringify(modelsConfig(options, connection), null, 2)}\n`);
  await writeFile(
    settingsPath,
    `${JSON.stringify(settingsConfig(options, connection), null, 2)}\n`
  );
  return { configDir, modelsPath, settingsPath };
}

function modelsConfig(options: LocalpiOptions, connection: RuntimeConnection): unknown {
  const models =
    connection.catalogModels.length === 0 ? fallbackCatalog(connection) : connection.catalogModels;
  return {
    providers: Object.fromEntries(
      groupedByProvider(models).map((entry) => [
        entry.providerId,
        providerConfig(options, connection, entry)
      ])
    )
  };
}

type ProviderGroup = {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly models: readonly CatalogModel[];
};

function groupedByProvider(models: readonly CatalogModel[]): readonly ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>();
  for (const model of models) {
    const existing = groups.get(model.providerId);
    groups.set(
      model.providerId,
      existing === undefined
        ? { providerId: model.providerId, baseUrl: model.baseUrl, models: [model] }
        : { ...existing, models: [...existing.models, model] }
    );
  }
  return [...groups.values()];
}

function providerConfig(
  options: LocalpiOptions,
  connection: RuntimeConnection,
  group: ProviderGroup
): unknown {
  return {
    baseUrl: group.baseUrl,
    api: "openai-completions",
    apiKey: "local",
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false
    },
    models: group.models.map((model) => modelConfig(options, connection, model))
  };
}

function modelConfig(
  options: LocalpiOptions,
  connection: RuntimeConnection,
  model: CatalogModel
): unknown {
  return withoutUndefined({
    id: model.modelId,
    name: model.displayName,
    reasoning: false,
    input: ["text"],
    contextWindow: modelContextWindow(options, connection, model),
    maxTokens: model.maxTokens ?? options.maxTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    }
  });
}

function modelContextWindow(
  options: LocalpiOptions,
  connection: RuntimeConnection,
  model: CatalogModel
): number | undefined {
  if (model.providerId === connection.providerId && model.modelId === connection.model) {
    return options.contextWindow ?? model.contextWindow;
  }
  return model.contextWindow;
}

function fallbackCatalog(connection: RuntimeConnection): readonly CatalogModel[] {
  return [
    {
      providerId: connection.providerId,
      providerName: connection.providerName,
      runtime: connection.runtime.startsWith("llama-server")
        ? "managed-llama-server"
        : "openai-compatible",
      baseUrl: connection.baseUrl,
      modelId: connection.model,
      aliases: [],
      displayName: `Local model (${connection.model})`,
      capabilities: ["text"],
      availability: "loaded",
      ...(connection.contextWindow === undefined ? {} : { contextWindow: connection.contextWindow })
    }
  ];
}

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  );
}

function settingsConfig(options: LocalpiOptions, connection: RuntimeConnection): unknown {
  const contextWindow = options.contextWindow ?? connection.contextWindow;
  return {
    defaultProvider: connection.providerId,
    defaultModel: connection.model,
    defaultThinkingLevel: options.thinking,
    enableInstallTelemetry: false,
    quietStartup: true,
    compaction: compactionConfig(contextWindow)
  };
}

function compactionConfig(contextWindow: number | undefined): unknown {
  if (contextWindow === undefined) {
    return { enabled: false };
  }
  return {
    enabled: true,
    reserveTokens: Math.max(256, Math.min(16384, Math.floor(contextWindow / 4))),
    keepRecentTokens: Math.max(512, Math.min(20000, Math.floor(contextWindow / 2)))
  };
}
