import type {
  PiAppDefinition,
  PiExtensionDefinition,
  PiModelDefinition,
  PiProviderDefinition
} from "pi-factory";

import type { CatalogModel } from "../localpi/catalog.js";
import type { LocalpiOptions } from "../localpi/options.js";
import type { RuntimeConnection } from "../localpi/runtime.js";
import type { ExtensionBundle } from "./extensions.js";

export function createLocalpiAppDefinition(
  options: LocalpiOptions,
  connection: RuntimeConnection,
  extensions?: ExtensionBundle
): PiAppDefinition {
  const providers = providersForConnection(options, connection);
  return {
    id: "localpi",
    name: "localpi",
    version: "0.3.0",
    stateDir: options.stateDir,
    sessionDir: options.sessionDir,
    piCommand: options.piCommand,
    providers,
    defaultProvider: connection.providerId,
    defaultModel: connection.model,
    thinking: options.thinking,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(extensions === undefined ? {} : extensionDefinition(extensions)),
    forwardedArgs: options.forwardedArgs
  };
}

function providersForConnection(
  options: LocalpiOptions,
  connection: RuntimeConnection
): readonly PiProviderDefinition[] {
  const models =
    connection.catalogModels.length === 0 ? fallbackCatalog(connection) : connection.catalogModels;
  return groupedByProvider(models).map((group) => ({
    id: group.providerId,
    baseUrl: group.baseUrl,
    api: "openai-completions",
    apiKey: "local",
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false
    },
    models: group.models.map((model) => modelDefinition(options, model))
  }));
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

function modelDefinition(options: LocalpiOptions, model: CatalogModel): PiModelDefinition {
  const contextWindow = modelContextWindow(options, model);
  return {
    id: model.modelId,
    name: model.displayName,
    reasoning: model.reasoning ?? false,
    ...(model.thinkingFormat === undefined ? {} : { thinkingFormat: model.thinkingFormat }),
    input: ["text"],
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(model.maxTokens === undefined
      ? { maxTokens: options.maxTokens }
      : { maxTokens: model.maxTokens })
  };
}

function modelContextWindow(options: LocalpiOptions, model: CatalogModel): number | undefined {
  if (options.contextWindow !== undefined) {
    return options.contextWindow;
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
      reasoning: false,
      capabilities: ["text"],
      availability: "loaded",
      ...(connection.contextWindow === undefined ? {} : { contextWindow: connection.contextWindow })
    }
  ];
}

function extensionDefinition(extensions: ExtensionBundle): {
  readonly extensions: readonly PiExtensionDefinition[];
  readonly appendSystemPrompts: readonly string[];
} {
  return {
    extensions: extensions.paths.map((extensionPath) => ({ path: extensionPath })),
    appendSystemPrompts: [extensions.systemPrompt]
  };
}
