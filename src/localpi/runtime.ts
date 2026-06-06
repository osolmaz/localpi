import { resolveLocalModel } from "../llm/openai.js";
import {
  ensureLlamaServer,
  llamaBaseUrl,
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
  const alias = await findModelAlias(requested);
  const model =
    alias === undefined
      ? await resolveLlamaModel(requested, options.chatTemplate)
      : await modelForAlias(requested, options);
  const runtime = await ensureLlamaServer(options, {
    id: model.id,
    modelPath: model.modelPath,
    ...optionalContextWindow(options.contextWindow ?? model.contextWindow),
    ...optionalChatTemplate(options.chatTemplate ?? model.chatTemplate)
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

async function modelForAlias(requested: string, options: LocalpiOptions) {
  return resolveLlamaModel(requested, options.chatTemplate);
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
