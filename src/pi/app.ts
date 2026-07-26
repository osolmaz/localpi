import type {
  PiAppDefinition,
  PiModelDefinition,
  PiProviderDefinition
} from "@dutifuldev/pi-factory";

import type { CatalogModel } from "../localpi/catalog.js";
import type { LocalpiOptions } from "../localpi/options.js";
import type { RuntimeConnection } from "../localpi/runtime.js";
import type { ExtensionBundle } from "./extensions.js";
import { localpiVersion } from "./version.js";

type LocalpiAppIdentity = Pick<PiAppDefinition, "id" | "name" | "version">;
type LocalpiAppDirectories = Pick<PiAppDefinition, "stateDir" | "sessionDir">;
type LocalpiPiCommand = Pick<PiAppDefinition, "piCommand" | "forwardedArgs">;
type LocalpiRuntimeSelection = Pick<
  PiAppDefinition,
  "providers" | "defaultProvider" | "defaultModel" | "thinking"
> &
  Partial<Pick<PiAppDefinition, "tools">>;
type LocalpiExtensionConfig = Partial<
  Pick<PiAppDefinition, "extensions" | "appendSystemPrompts" | "env">
>;

const localpiAppIdentity: LocalpiAppIdentity = {
  id: "localpi",
  name: "localpi",
  version: localpiVersion
};

const demoLaunchOverrideBooleanFlags = new Set([
  "--no-tools",
  "-nt",
  "--no-builtin-tools",
  "-nbt",
  "--approve",
  "-a",
  "--no-approve",
  "-na"
]);

const demoLaunchOverrideValueFlags = new Set(["--tools", "-t", "--exclude-tools", "-xt"]);
const demoLaunchOverrideEqualsFlags = ["--tools=", "--exclude-tools="] as const;

export function createLocalpiAppDefinition(
  options: LocalpiOptions,
  connection: RuntimeConnection,
  extensions?: ExtensionBundle
): PiAppDefinition {
  return {
    ...localpiAppIdentity,
    ...appDirectories(options),
    ...piCommand(options),
    ...runtimeSelection(options, connection),
    ...extensionConfig(extensions)
  };
}

function appDirectories(options: LocalpiOptions): LocalpiAppDirectories {
  return {
    stateDir: options.stateDir,
    sessionDir: options.sessionDir
  };
}

function piCommand(options: LocalpiOptions): LocalpiPiCommand {
  return {
    piCommand: options.piCommand,
    forwardedArgs: options.demo ? demoForwardedArgs(options.forwardedArgs) : options.forwardedArgs
  };
}

function demoForwardedArgs(args: readonly string[]): readonly string[] {
  return [...withoutConflictingDemoFlags(args), "--no-tools", "--no-approve"];
}

function withoutConflictingDemoFlags(args: readonly string[]): readonly string[] {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (isDemoLaunchOverrideFlag(arg)) {
      if (isValueFlag(arg) && !arg.includes("=")) {
        index += 1;
      }
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function isDemoLaunchOverrideFlag(arg: string): boolean {
  return (
    demoLaunchOverrideBooleanFlags.has(arg) ||
    isValueFlag(arg) ||
    demoLaunchOverrideEqualsFlags.some((flag) => arg.startsWith(flag))
  );
}

function isValueFlag(arg: string): boolean {
  return demoLaunchOverrideValueFlags.has(arg);
}

function runtimeSelection(
  options: LocalpiOptions,
  connection: RuntimeConnection
): LocalpiRuntimeSelection {
  const selection = {
    providers: providersForConnection(options, connection),
    defaultProvider: connection.providerId,
    defaultModel: connection.model,
    thinking: options.thinking
  };
  return options.tools === undefined ? selection : { ...selection, tools: options.tools };
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

function extensionConfig(extensions: ExtensionBundle | undefined): LocalpiExtensionConfig {
  if (extensions === undefined) {
    return {};
  }
  return {
    extensions: extensions.paths.map((extensionPath) => ({ path: extensionPath })),
    appendSystemPrompts: [extensions.systemPrompt],
    ...(Object.keys(extensions.env).length === 0 ? {} : { env: extensions.env })
  };
}
