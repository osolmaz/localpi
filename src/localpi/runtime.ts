import { resolveLocalModel } from "../llm/openai.js";
import {
  ensureLlamaServer,
  getManagedLlamaServerMetadata,
  getLlamaServerModels,
  llamaBaseUrl,
  managedLlamaServerNeedsRestart,
  llamaServerStatus,
  stopManagedLlamaServer
} from "./llama-server.js";
import {
  defaultLlamaModelName,
  findModelAlias,
  listModelAliases,
  resolveLlamaModel
} from "./models.js";
import type { LocalpiOptions } from "./options.js";

export type RuntimeConnection = {
  readonly runtime: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly availableModels: readonly string[];
  readonly contextWindow?: number;
  readonly warnings: readonly string[];
};

export async function resolveRuntime(options: LocalpiOptions): Promise<RuntimeConnection> {
  switch (options.runtime) {
    case "llama-server":
      return resolveLlamaRuntime(options);
    case "lmstudio":
      return resolveOpenAiRuntime(
        options,
        options.baseUrl ?? "http://127.0.0.1:1234/v1",
        "lmstudio"
      );
    case "openai-compatible":
      return resolveOpenAiRuntime(options, requiredBaseUrl(options), "openai-compatible");
  }
}

export async function stopRuntime(options: LocalpiOptions): Promise<string> {
  if (options.runtime !== "llama-server") {
    return `runtime ${options.runtime} is externally managed; nothing stopped`;
  }
  return stopManagedLlamaServer(options);
}

export async function statusOutput(options: LocalpiOptions): Promise<string> {
  if (options.runtime === "llama-server") {
    return `${await llamaServerStatus(options)}\n${await aliasListOutput()}`;
  }
  const connection = await resolveRuntime(options);
  return connectionStatus(connection);
}

export async function aliasListOutput(): Promise<string> {
  const aliases = await listModelAliases();
  return aliases
    .map((alias) => {
      const context =
        alias.contextWindow === undefined ? "" : ` ctx=${String(alias.contextWindow)}`;
      return `${alias.name}: id=${alias.id}${context}\n  ${alias.paths.join("\n  ")}`;
    })
    .join("\n");
}

export function connectionStatus(connection: RuntimeConnection): string {
  return (
    [
      `runtime: ${connection.runtime}`,
      `base url: ${connection.baseUrl}`,
      `model: ${connection.model}`,
      `available models: ${connection.availableModels.join(", ")}`,
      `context window: ${String(connection.contextWindow ?? "unspecified")}`,
      ...connection.warnings.map((warning) => `warning: ${warning}`)
    ].join("\n") + "\n"
  );
}

async function resolveLlamaRuntime(options: LocalpiOptions): Promise<RuntimeConnection> {
  const requested = options.model ?? defaultLlamaModelName();
  const existing = await existingLlamaRuntime(options, requested);
  if (existing !== undefined) {
    return existing;
  }
  const model = await resolveLlamaModelForStart(requested, options);
  const runtime = await ensureLlamaServer(options, {
    ...llamaModelForStart(model, options)
  });
  return {
    runtime: runtime.managed ? "llama-server" : "llama-server/external",
    baseUrl: runtime.baseUrl,
    model: runtime.model,
    availableModels: runtime.availableModels,
    warnings: runtime.warnings,
    ...optionalContextWindow(options.contextWindow ?? runtime.contextWindow)
  };
}

async function resolveLlamaModelForStart(
  requested: string,
  options: LocalpiOptions
): Promise<Awaited<ReturnType<typeof resolveLlamaModel>>> {
  try {
    return await resolveLlamaModel(requested, options.chatTemplate);
  } catch (error) {
    const managed = await getManagedLlamaServerMetadata(options);
    if (managed !== undefined && (requested === "auto" || requested === managed.modelId)) {
      return {
        source: "path",
        name: managed.modelId,
        id: managed.modelId,
        modelPath: managed.modelPath,
        contextWindow: managed.contextWindow,
        ...optionalChatTemplate(options.chatTemplate ?? managed.chatTemplate)
      };
    }
    throw error;
  }
}

async function existingLlamaRuntime(
  options: LocalpiOptions,
  requested: string
): Promise<RuntimeConnection | undefined> {
  const match = await existingModelMatch(options, requested);
  if (match === undefined) {
    return undefined;
  }
  const managed = await getManagedLlamaServerMetadata(options);
  const reportedContextWindow = reportedRuntimeContext(managed, match);
  if (
    managed !== undefined &&
    shouldResolveManagedThroughStartPath(managed, options, requested, match.modelId)
  ) {
    return undefined;
  }
  if (shouldRestartManagedForContext(options, managed, reportedContextWindow)) {
    return undefined;
  }
  assertCompatibleRuntimeContext(options, match.modelId, reportedContextWindow);
  return existingRuntimeConnection(options, match, managed, reportedContextWindow);
}

function existingRuntimeConnection(
  options: LocalpiOptions,
  match: ExistingModelMatch,
  managed: Awaited<ReturnType<typeof getManagedLlamaServerMetadata>>,
  reportedContextWindow: number | undefined
): RuntimeConnection {
  return {
    runtime: runtimeName(managed),
    baseUrl: llamaBaseUrl(options),
    model: match.modelId,
    availableModels: match.models.map((model) => model.id),
    warnings: [],
    ...optionalContextWindow(options.contextWindow ?? reportedContextWindow)
  };
}

function reportedRuntimeContext(
  managed: Awaited<ReturnType<typeof getManagedLlamaServerMetadata>>,
  match: ExistingModelMatch
): number | undefined {
  return managed?.contextWindow ?? match.info?.contextWindow;
}

function runtimeName(
  managed: Awaited<ReturnType<typeof getManagedLlamaServerMetadata>>
): "llama-server" | "llama-server/external" {
  return managed === undefined ? "llama-server/external" : "llama-server";
}

type ExistingModelMatch = {
  readonly models: readonly { readonly id: string; readonly contextWindow?: number }[];
  readonly modelId: string;
  readonly info: { readonly id: string; readonly contextWindow?: number } | undefined;
};

async function existingModelMatch(
  options: LocalpiOptions,
  requested: string
): Promise<ExistingModelMatch | undefined> {
  const models = await getLlamaServerModels(options);
  if (models === undefined) {
    return undefined;
  }
  const modelId = await existingModelId(requested, models);
  if (modelId === undefined) {
    return undefined;
  }
  return {
    models,
    modelId,
    info: models.find((model) => model.id === modelId)
  };
}

function shouldRestartManagedForContext(
  options: LocalpiOptions,
  managed: Awaited<ReturnType<typeof getManagedLlamaServerMetadata>>,
  reportedContextWindow: number | undefined
): boolean {
  return (
    managed !== undefined &&
    options.contextWindow !== undefined &&
    reportedContextWindow !== undefined &&
    reportedContextWindow !== options.contextWindow
  );
}

function shouldResolveManagedThroughStartPath(
  managed: NonNullable<Awaited<ReturnType<typeof getManagedLlamaServerMetadata>>>,
  options: LocalpiOptions,
  requested: string,
  modelId: string
): boolean {
  return (
    managedLlamaServerNeedsRestart(options, managed) ||
    (requested !== "auto" && requested !== modelId)
  );
}

function assertCompatibleRuntimeContext(
  options: LocalpiOptions,
  modelId: string,
  reportedContextWindow: number | undefined
): void {
  if (
    options.contextWindow !== undefined &&
    reportedContextWindow !== undefined &&
    reportedContextWindow !== options.contextWindow
  ) {
    throw new Error(
      `server at ${llamaBaseUrl(options)} reports ${modelId} ctx=${String(reportedContextWindow)}, but --ctx ${String(options.contextWindow)} was requested`
    );
  }
}

async function existingModelId(
  requested: string,
  models: readonly { readonly id: string }[]
): Promise<string | undefined> {
  if (requested === "auto") {
    return models[0]?.id;
  }
  if (models.some((model) => model.id === requested)) {
    return requested;
  }
  const alias = await findModelAlias(requested);
  return alias !== undefined && models.some((model) => model.id === alias.id)
    ? alias.id
    : undefined;
}

function llamaModelForStart(
  model: Awaited<ReturnType<typeof resolveLlamaModel>>,
  options: LocalpiOptions
) {
  return {
    id: model.id,
    modelPath: model.modelPath,
    ...optionalContextWindow(options.contextWindow ?? model.contextWindow),
    ...optionalChatTemplate(options.chatTemplate ?? model.chatTemplate)
  };
}

async function resolveOpenAiRuntime(
  options: LocalpiOptions,
  baseUrl: string,
  runtime: string
): Promise<RuntimeConnection> {
  const resolved = await resolveLocalModel(baseUrl, options.model ?? "auto", options.timeoutMs);
  return {
    runtime,
    baseUrl,
    model: resolved.model,
    availableModels: resolved.availableModels,
    warnings: [],
    ...optionalContextWindow(options.contextWindow ?? resolved.contextWindow)
  };
}

function requiredBaseUrl(options: LocalpiOptions): string {
  if (options.baseUrl === undefined) {
    throw new Error("--runtime openai-compatible requires --base-url");
  }
  return options.baseUrl;
}

export function effectiveBaseUrl(options: LocalpiOptions): string {
  switch (options.runtime) {
    case "llama-server":
      return llamaBaseUrl(options);
    case "lmstudio":
      return options.baseUrl ?? "http://127.0.0.1:1234/v1";
    case "openai-compatible":
      return requiredBaseUrl(options);
  }
}

function optionalContextWindow(contextWindow: number | undefined): {
  readonly contextWindow?: number;
} {
  return contextWindow === undefined ? {} : { contextWindow };
}

function optionalChatTemplate(chatTemplate: string | undefined): {
  readonly chatTemplate?: string;
} {
  return chatTemplate === undefined ? {} : { chatTemplate };
}
