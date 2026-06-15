import {
  ensureLlamaServer,
  getManagedLlamaServerMetadata,
  getLlamaServerModels,
  llamaBaseUrl,
  managedLlamaServerNeedsRestart,
  llamaServerStatus,
  stopManagedLlamaServer
} from "./llama-server.js";
import type { CatalogModel, ModelCatalog } from "./catalog.js";
import { discoverModelCatalog } from "./catalog.js";
import {
  defaultLlamaModelName,
  findModelAlias,
  listModelAliases,
  resolveLlamaModel
} from "./models.js";
import type { LocalpiOptions } from "./options.js";

export type RuntimeConnection = {
  readonly runtime: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly availableModels: readonly string[];
  readonly catalogModels: readonly CatalogModel[];
  readonly contextWindow?: number;
  readonly warnings: readonly string[];
};

export type ModelSelectionRequest = {
  readonly models: readonly CatalogModel[];
};

export type ModelSelector = (request: ModelSelectionRequest) => Promise<CatalogModel | undefined>;

export async function resolveRuntime(
  options: LocalpiOptions,
  selectModel?: ModelSelector
): Promise<RuntimeConnection> {
  if (options.runtime === "auto") {
    return resolveCatalogRuntime(options, selectModel);
  }
  switch (options.runtime) {
    case "llama-server":
      return resolveLlamaRuntime(options);
    case "lmstudio":
      return resolveCatalogRuntime(options, selectModel);
    case "vllm":
      return resolveCatalogRuntime(options, selectModel);
    case "openai-compatible":
      return resolveCatalogRuntime(options, selectModel);
  }
}

export async function stopRuntime(options: LocalpiOptions): Promise<string> {
  if (
    options.runtime === "lmstudio" ||
    options.runtime === "vllm" ||
    options.runtime === "openai-compatible"
  ) {
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
      `provider: ${connection.providerId}`,
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

export function effectiveBaseUrl(options: LocalpiOptions): string {
  if (options.runtime === "llama-server") {
    return llamaBaseUrl(options);
  }
  if (options.runtime === "openai-compatible") {
    return requiredOpenAiBaseUrl(options);
  }
  return options.baseUrl ?? defaultExternalBaseUrl(options.runtime);
}

function requiredOpenAiBaseUrl(options: LocalpiOptions): string {
  if (options.baseUrl === undefined) {
    throw new Error("--runtime openai-compatible requires --base-url");
  }
  return options.baseUrl;
}

function defaultExternalBaseUrl(runtime: "auto" | "lmstudio" | "vllm"): string {
  return runtime === "vllm" ? "http://127.0.0.1:8000/v1" : "http://127.0.0.1:1234/v1";
}

async function resolveCatalogRuntime(
  options: LocalpiOptions,
  selectModel: ModelSelector | undefined
): Promise<RuntimeConnection> {
  const catalog = await discoverModelCatalog(options);
  const selected = await selectCatalogModel(options, catalog, selectModel);
  if (selected.runtime === "managed-llama-server" && selected.availability === "startable") {
    return startSelectedLlamaRuntime(options, selected, catalog);
  }
  return catalogRuntimeConnection(options, selected, catalog);
}

async function selectCatalogModel(
  options: LocalpiOptions,
  catalog: ModelCatalog,
  selectModel: ModelSelector | undefined
): Promise<CatalogModel> {
  const selection = normalizedSelection(options, catalog.models);
  const providerFiltered = modelsForProvider(catalog.models, selection.provider);
  if (providerFiltered.length === 0) {
    throw new Error(`provider ${selection.provider ?? ""} did not report usable models`);
  }
  if (selection.model !== "auto") {
    return exactCatalogModel(providerFiltered, selection.model);
  }
  return selectAutomaticCatalogModel(providerFiltered, catalog.warnings, selectModel);
}

async function selectAutomaticCatalogModel(
  models: readonly CatalogModel[],
  warnings: readonly string[],
  selectModel: ModelSelector | undefined
): Promise<CatalogModel> {
  const loaded = models.filter((model) => model.availability === "loaded");
  const [onlyLoaded] = loaded;
  if (onlyLoaded !== undefined && loaded.length === 1) {
    return onlyLoaded;
  }
  if (loaded.length > 1) {
    const selected = selectModel === undefined ? undefined : await selectModel({ models: loaded });
    if (selected !== undefined) {
      return selected;
    }
    throw new Error(
      `multiple loaded models available; choose one with --provider and --model:\n${modelChoiceList(loaded)}`
    );
  }
  const fallback = startableFallback(models);
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(
    `no loaded models available${warnings.length === 0 ? "" : `; ${warnings.join("; ")}`}`
  );
}

function modelsForProvider(
  models: readonly CatalogModel[],
  provider: string | undefined
): readonly CatalogModel[] {
  return provider === undefined ? models : models.filter((model) => model.providerId === provider);
}

function normalizedSelection(
  options: LocalpiOptions,
  models: readonly CatalogModel[]
): { readonly provider: string | undefined; readonly model: string } {
  const requested = options.model ?? "auto";
  if (options.provider !== undefined || requested === "auto") {
    return { provider: options.provider, model: requested };
  }
  const separator = requested.indexOf("/");
  if (separator <= 0) {
    return { provider: options.provider, model: requested };
  }
  const provider = requested.slice(0, separator);
  if (!models.some((model) => model.providerId === provider)) {
    return { provider: options.provider, model: requested };
  }
  return { provider, model: requested.slice(separator + 1) };
}

function exactCatalogModel(models: readonly CatalogModel[], requested: string): CatalogModel {
  const matches = models.filter(
    (model) => model.modelId === requested || model.aliases.includes(requested)
  );
  const [onlyMatch] = matches;
  if (onlyMatch !== undefined && matches.length === 1) {
    return onlyMatch;
  }
  if (matches.length > 1) {
    throw new Error(
      `model ${requested} is available from multiple providers; choose one with --provider:\n${modelChoiceList(matches)}`
    );
  }
  throw new Error(`model ${requested} is not available; choices:\n${modelChoiceList(models)}`);
}

function startableFallback(models: readonly CatalogModel[]): CatalogModel | undefined {
  const startable = models.filter((model) => model.availability === "startable");
  return (
    startable.find(
      (model) =>
        model.aliases.includes(defaultLlamaModelName()) || model.modelId === defaultLlamaModelName()
    ) ?? startable[0]
  );
}

async function startSelectedLlamaRuntime(
  options: LocalpiOptions,
  selected: CatalogModel,
  catalog: ModelCatalog
): Promise<RuntimeConnection> {
  const model = await resolveLlamaModelForStart(selected.modelId, options);
  const runtime = await ensureLlamaServer(options, llamaModelForStart(model, options));
  const loadedSelected = catalogModelFromModelInfo(
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
  return catalogRuntimeConnection(options, loadedSelected, {
    models: replaceSelectedStartable(catalog.models, selected, loadedSelected),
    warnings: [...catalog.warnings, ...runtime.warnings]
  });
}

function catalogRuntimeConnection(
  options: LocalpiOptions,
  selected: CatalogModel,
  catalog: ModelCatalog
): RuntimeConnection {
  const providerModels = catalog.models.filter(
    (model) => model.providerId === selected.providerId && model.availability === "loaded"
  );
  return {
    runtime: connectionRuntimeName(selected),
    providerId: selected.providerId,
    providerName: selected.providerName,
    baseUrl: selected.baseUrl,
    model: selected.modelId,
    availableModels: providerModels.map((model) => model.modelId),
    catalogModels: catalog.models.filter((model) => model.availability === "loaded"),
    warnings: catalog.warnings,
    ...optionalContextWindow(options.contextWindow ?? selected.contextWindow)
  };
}

function connectionRuntimeName(selected: CatalogModel): string {
  if (selected.runtime === "managed-llama-server") {
    return "llama-server";
  }
  return selected.providerId === "lmstudio" || selected.providerId === "vllm"
    ? selected.providerId
    : selected.runtime;
}

function replaceSelectedStartable(
  models: readonly CatalogModel[],
  selected: CatalogModel,
  loadedSelected: CatalogModel
): readonly CatalogModel[] {
  return models.map((model) => (model === selected ? loadedSelected : model));
}

function modelChoiceList(models: readonly CatalogModel[]): string {
  return models
    .map((model) => `  ${model.providerId}/${model.modelId} (${model.displayName})`)
    .join("\n");
}

function catalogModelFromModelInfo(
  providerId: string,
  providerName: string,
  runtime: "openai-compatible" | "managed-llama-server",
  baseUrl: string,
  model: { readonly id: string; readonly contextWindow?: number },
  options: LocalpiOptions,
  contextWindow?: number
): CatalogModel {
  return {
    providerId,
    providerName,
    runtime,
    baseUrl,
    modelId: model.id,
    aliases: [],
    displayName: `${providerName} / ${model.id}`,
    maxTokens: options.maxTokens,
    capabilities: ["text"],
    availability: "loaded",
    ...optionalContextWindow(contextWindow ?? model.contextWindow)
  };
}

function connectionCatalogModels(
  providerId: string,
  providerName: string,
  runtime: "openai-compatible" | "managed-llama-server",
  baseUrl: string,
  modelIds: readonly string[],
  options: LocalpiOptions,
  contextWindow?: number
): readonly CatalogModel[] {
  return modelIds.map((modelId) =>
    catalogModelFromModelInfo(
      providerId,
      providerName,
      runtime,
      baseUrl,
      contextWindow === undefined ? { id: modelId } : { id: modelId, contextWindow },
      options,
      contextWindow
    )
  );
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
