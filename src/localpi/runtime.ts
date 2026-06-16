import { discoverModelCatalog, formatCatalogWarning } from "./catalog.js";
import { llamaBaseUrl, llamaServerStatus, stopManagedLlamaServer } from "./llama-server.js";
import { listModelAliases } from "./models.js";
import {
  catalogRuntimeConnection,
  connectionStatus,
  statusModelList
} from "./runtime-connection.js";
import { resolveLlamaRuntime, resolveSelectedLlamaRuntime } from "./managed-runtime.js";
import { selectCatalogModel } from "./runtime-selection.js";
import type { LocalpiOptions } from "./options.js";
import type { RuntimeConnection } from "./runtime-types.js";

export type { RuntimeConnection } from "./runtime-types.js";
export { connectionStatus } from "./runtime-connection.js";

export async function resolveRuntime(options: LocalpiOptions): Promise<RuntimeConnection> {
  if (options.runtime === "auto") {
    return resolveCatalogRuntime(options);
  }
  switch (options.runtime) {
    case "llama-server":
      return resolveLlamaRuntime(options);
    case "lmstudio":
      return resolveCatalogRuntime(options);
    case "vllm":
      return resolveCatalogRuntime(options);
    case "openai-compatible":
      return resolveCatalogRuntime(options);
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
  if (statusShouldUseCatalog(options)) {
    return catalogStatusOutput(options);
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

export function effectiveBaseUrl(options: LocalpiOptions): string {
  if (options.runtime === "llama-server") {
    return llamaBaseUrl(options);
  }
  if (options.runtime === "openai-compatible") {
    return requiredOpenAiBaseUrl(options);
  }
  return options.baseUrl ?? defaultExternalBaseUrl(options.runtime);
}

async function resolveCatalogRuntime(options: LocalpiOptions): Promise<RuntimeConnection> {
  const catalog = await discoverModelCatalog(options);
  const selected = await selectCatalogModel(options, catalog);
  if (selected.runtime === "managed-llama-server") {
    return resolveSelectedLlamaRuntime(options, selected, catalog);
  }
  return catalogRuntimeConnection(options, selected, catalog);
}

function statusShouldUseCatalog(options: LocalpiOptions): boolean {
  return options.runtime === "auto" || options.model === undefined || options.model === "auto";
}

async function catalogStatusOutput(options: LocalpiOptions): Promise<string> {
  const catalog = await discoverModelCatalog(options);
  const loaded = catalog.models.filter((model) => model.availability === "loaded");
  const startable = catalog.models.filter((model) => model.availability === "startable");
  return (
    [
      `runtime: ${options.runtime}`,
      `loaded models: ${statusModelList(loaded)}`,
      `startable models: ${statusModelList(startable)}`,
      ...catalog.warnings.map((warning) => `warning: ${formatCatalogWarning(warning)}`)
    ].join("\n") + "\n"
  );
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
