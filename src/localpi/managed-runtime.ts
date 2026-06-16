import {
  ensureLlamaServer,
  getManagedLlamaServerMetadata,
  getLlamaServerModels,
  llamaBaseUrl,
  managedLlamaServerNeedsRestart,
  stopManagedLlamaServer
} from "./llama-server.js";
import {
  managedModelSupportsReasoning,
  runtimeCatalogWarning,
  type CatalogModel,
  type CatalogWarning,
  type ModelCatalog
} from "./catalog.js";
import {
  catalogModelFromModelInfo,
  catalogRuntimeConnection,
  connectionCatalogModels,
  modelChoiceList,
  optionalContextWindow,
  replaceManagedLoadedModels
} from "./runtime-connection.js";
import { defaultLlamaModelName, findModelAlias, resolveLlamaModel } from "./models.js";
import type { LocalpiOptions } from "./options.js";
import type { RuntimeConnection } from "./runtime-types.js";

export async function resolveLlamaRuntime(options: LocalpiOptions): Promise<RuntimeConnection> {
  const requested = options.model ?? defaultLlamaModelName();
  const existing = await existingLlamaRuntime(options, requested);
  if (existing !== undefined) {
    return existing;
  }
  const model = await resolveLlamaModelForStart(requested, options);
  const modelForStart = llamaModelForStart(model, options);
  await assertDirectLlamaStartIsSafe(options, modelForStart);
  const runtime = await ensureLlamaServer(options, modelForStart);
  return {
    runtime: runtime.managed ? "llama-server" : "llama-server/external",
    providerId: "llama-server",
    providerName: "llama-server",
    baseUrl: runtime.baseUrl,
    model: runtime.model,
    availableModels: runtime.availableModels,
    catalogModels: connectionCatalogModels(
      "llama-server",
      "llama-server",
      "managed-llama-server",
      runtime.baseUrl,
      runtime.availableModels,
      options,
      runtime.contextWindow
    ),
    warnings: runtime.warnings,
    ...optionalContextWindow(options.contextWindow ?? runtime.contextWindow)
  };
}

export async function resolveSelectedLlamaRuntime(
  options: LocalpiOptions,
  selected: CatalogModel,
  catalog: ModelCatalog
): Promise<RuntimeConnection> {
  const existing =
    selected.availability === "loaded"
      ? await existingLlamaRuntime(options, selected.modelId)
      : undefined;
  if (existing !== undefined) {
    const selectedModel = managedCatalogModelFromConnection(options, selected, existing);
    return catalogRuntimeConnection(options, selectedModel, {
      models: replaceManagedLoadedModels(catalog.models, selected, existing.catalogModels),
      warnings: [
        ...catalog.warnings,
        ...runtimeWarnings("llama-server", "llama-server", existing.warnings)
      ]
    });
  }
  return startSelectedLlamaRuntime(options, selected, catalog);
}

export async function customPathCatalogModel(
  options: LocalpiOptions,
  provider: string | undefined,
  requested: string
): Promise<CatalogModel | undefined> {
  if (
    options.runtime !== "auto" ||
    (provider !== undefined && provider !== "llama-server") ||
    !isGgufPathRequest(requested)
  ) {
    return undefined;
  }
  const resolved = await resolveLlamaModelForStart(requested, options);
  return {
    providerId: "llama-server",
    providerName: "llama-server",
    runtime: "managed-llama-server",
    baseUrl: llamaBaseUrl(options),
    modelId: resolved.id,
    aliases: [requested],
    displayName: `llama-server / ${resolved.name}`,
    maxTokens: options.maxTokens,
    reasoning: managedModelSupportsReasoning(resolved.id),
    capabilities: ["text"],
    availability: "startable",
    ...optionalContextWindow(options.contextWindow ?? resolved.contextWindow)
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
    providerId: "llama-server",
    providerName: "llama-server",
    baseUrl: llamaBaseUrl(options),
    model: match.modelId,
    availableModels: match.models.map((model) => model.id),
    catalogModels: match.models.map((model) =>
      catalogModelFromModelInfo(
        "llama-server",
        "llama-server",
        "managed-llama-server",
        llamaBaseUrl(options),
        model,
        options,
        model.id === match.modelId ? reportedContextWindow : model.contextWindow
      )
    ),
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

async function startSelectedLlamaRuntime(
  options: LocalpiOptions,
  selected: CatalogModel,
  catalog: ModelCatalog
): Promise<RuntimeConnection> {
  const model = await resolveLlamaModelForStart(selected.aliases[0] ?? selected.modelId, options);
  const modelForStart = llamaModelForStart(model, options);
  await stopStaleManagedLlamaServer(options, modelForStart);
  assertNoLoadedExternalModels(catalog);
  const runtime = await ensureLlamaServer(options, modelForStart);
  const loadedSelected = runtimeSelectedCatalogModel(options, selected, runtime);
  return catalogRuntimeConnection(options, loadedSelected, {
    models: replaceManagedLoadedModels(catalog.models, selected, [loadedSelected]),
    warnings: [
      ...catalog.warnings,
      ...runtimeWarnings("llama-server", "llama-server", runtime.warnings)
    ]
  });
}

async function assertDirectLlamaStartIsSafe(
  options: LocalpiOptions,
  model: ReturnType<typeof llamaModelForStart>
): Promise<void> {
  const { discoverModelCatalog } = await import("./catalog.js");
  const catalog = await discoverModelCatalog({
    ...options,
    runtime: "auto",
    provider: undefined,
    model: "auto"
  });
  try {
    assertNoLoadedExternalModels(catalog);
  } catch (error) {
    await stopStaleManagedLlamaServer(options, model);
    throw error;
  }
}

async function stopStaleManagedLlamaServer(
  options: LocalpiOptions,
  model: ReturnType<typeof llamaModelForStart>
): Promise<void> {
  const managed = await getManagedLlamaServerMetadata(options);
  if (managed !== undefined && managedLlamaServerNeedsRestart(options, managed, model)) {
    await stopManagedLlamaServer(options);
  }
}

function runtimeSelectedCatalogModel(
  options: LocalpiOptions,
  selected: CatalogModel,
  runtime: Awaited<ReturnType<typeof ensureLlamaServer>>
): CatalogModel {
  return catalogModelFromModelInfo(
    selected.providerId,
    selected.providerName,
    "managed-llama-server",
    runtime.baseUrl,
    runtime.contextWindow === undefined
      ? { id: runtime.model }
      : { id: runtime.model, contextWindow: runtime.contextWindow },
    options,
    runtime.contextWindow
  );
}

function managedCatalogModelFromConnection(
  options: LocalpiOptions,
  selected: CatalogModel,
  connection: RuntimeConnection
): CatalogModel {
  return catalogModelFromModelInfo(
    selected.providerId,
    selected.providerName,
    "managed-llama-server",
    connection.baseUrl,
    connection.contextWindow === undefined
      ? { id: connection.model }
      : { id: connection.model, contextWindow: connection.contextWindow },
    options,
    connection.contextWindow
  );
}

function assertNoLoadedExternalModels(catalog: ModelCatalog): void {
  const external = catalog.models.filter(
    (model) => model.runtime !== "managed-llama-server" && model.availability === "loaded"
  );
  if (external.length === 0) {
    return;
  }
  throw new Error(
    `external local models are already loaded; choose one or unload them before starting llama-server:\n${modelChoiceList(external)}`
  );
}

function runtimeWarnings(
  providerId: string,
  providerName: string,
  warnings: readonly string[]
): readonly CatalogWarning[] {
  return warnings.map((warning) => runtimeCatalogWarning(providerId, providerName, warning));
}

function isGgufPathRequest(value: string): boolean {
  return value.endsWith(".gguf") || value.includes("/") || value.includes("\\");
}

function optionalChatTemplate(chatTemplate: string | undefined): {
  readonly chatTemplate?: string;
} {
  return chatTemplate === undefined ? {} : { chatTemplate };
}
