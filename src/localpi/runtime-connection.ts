import { paint } from "./catppuccin.js";

import {
  formatCatalogWarning,
  managedCapabilityConfig,
  type CatalogModel,
  type ModelCatalog
} from "./catalog.js";
import type { LocalpiOptions } from "./options.js";
import type { RuntimeConnection } from "./runtime-types.js";

export function connectionStatus(connection: RuntimeConnection): string {
  return (
    [
      `${paint("runtime:", "overlay1")} ${connection.runtime}`,
      `${paint("provider:", "overlay1")} ${connection.providerId}`,
      `${paint("base url:", "overlay1")} ${connection.baseUrl}`,
      `${paint("model:", "overlay1")} ${connection.model}`,
      `${paint("available models:", "overlay1")} ${connection.availableModels.join(", ")}`,
      `${paint("context window:", "overlay1")} ${String(connection.contextWindow ?? "unspecified")}`,
      ...connection.warnings.map((warning) => `${paint("warning:", "peach")} ${warning}`)
    ].join("\n") + "\n"
  );
}

export function statusModelList(models: readonly CatalogModel[]): string {
  return models.length === 0
    ? "none"
    : models.map((model) => `${model.providerId}/${model.modelId}`).join(", ");
}

export function catalogRuntimeConnection(
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
    warnings: catalog.warnings.map(formatCatalogWarning),
    ...optionalContextWindow(options.contextWindow ?? selected.contextWindow)
  };
}

export function catalogModelFromModelInfo(
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
    ...(runtime === "managed-llama-server" ? managedCapabilityConfig(model.id, options) : {}),
    capabilities: ["text"],
    availability: "loaded",
    ...optionalContextWindow(contextWindow ?? model.contextWindow)
  };
}

export function connectionCatalogModels(
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

export function replaceManagedLoadedModels(
  models: readonly CatalogModel[],
  selected: CatalogModel,
  loaded: readonly CatalogModel[]
): readonly CatalogModel[] {
  return [
    ...models.filter(
      (model) =>
        model !== selected &&
        !(model.providerId === "llama-server" && model.availability === "loaded")
    ),
    ...loaded
  ];
}

export function modelChoiceList(models: readonly CatalogModel[]): string {
  return models
    .map((model) => `  ${model.providerId}/${model.modelId} (${model.displayName})`)
    .join("\n");
}

export function optionalContextWindow(contextWindow: number | undefined): {
  readonly contextWindow?: number;
} {
  return contextWindow === undefined ? {} : { contextWindow };
}

function connectionRuntimeName(selected: CatalogModel): string {
  if (selected.runtime === "managed-llama-server") {
    return "llama-server";
  }
  return selected.providerId === "lmstudio" ||
    selected.providerId === "vllm" ||
    selected.providerId === "llama-cpp"
    ? selected.providerId
    : selected.runtime;
}
