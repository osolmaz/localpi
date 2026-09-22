import { asArray, asObject, optionalString } from "../common/json.js";

type Fetcher = typeof fetch;

export type ModelStatus = "loaded" | "unloaded";

export type ModelInfo = {
  readonly id: string;
  readonly contextWindow?: number;
  readonly status?: ModelStatus;
};

export type ServerProps = {
  readonly role?: string;
  readonly modelsAutoload?: boolean;
};

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/u, "");
}

export async function listModels(
  baseUrl: string,
  timeoutMs = 3000,
  fetcher: Fetcher = fetch
): Promise<readonly ModelInfo[]> {
  const response = await fetcher(`${normalizeBaseUrl(baseUrl)}/models`, {
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`model list failed with HTTP ${String(response.status)}`);
  }
  const payload: unknown = await response.json();
  const root = asObject(payload, "models response");
  const data = asArray(root["data"], "models response data");
  return data
    .map((entry) => modelInfo(asObject(entry, "model entry")))
    .filter((model): model is ModelInfo => model !== undefined);
}

export async function fetchServerProps(
  baseUrl: string,
  timeoutMs = 3000,
  fetcher: Fetcher = fetch
): Promise<ServerProps> {
  const response = await fetcher(`${serverRootUrl(baseUrl)}/props`, {
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`server props failed with HTTP ${String(response.status)}`);
  }
  const payload: unknown = await response.json();
  const root = asObject(payload, "server props response");
  const role = optionalString(root["role"]);
  const modelsAutoload = optionalBoolean(root["models_autoload"]);
  return {
    ...(role === undefined ? {} : { role }),
    ...(modelsAutoload === undefined ? {} : { modelsAutoload })
  };
}

export async function resolveLocalModel(
  baseUrl: string,
  requestedModel: string,
  timeoutMs = 3000,
  fetcher: Fetcher = fetch
): Promise<{
  readonly model: string;
  readonly availableModels: readonly string[];
  readonly contextWindow?: number;
}> {
  const modelInfos = await listModels(baseUrl, timeoutMs, fetcher);
  const availableModels = modelInfos.map((model) => model.id);
  if (requestedModel === "auto") {
    const first = modelInfos[0];
    if (first === undefined) {
      throw new Error(`no models returned by ${normalizeBaseUrl(baseUrl)}/models`);
    }
    return withOptionalContextWindow({ model: first.id, availableModels }, first.contextWindow);
  }
  if (availableModels.length > 0 && !availableModels.includes(requestedModel)) {
    throw new Error(
      `model ${requestedModel} is not reported by ${normalizeBaseUrl(baseUrl)}/models; available: ${availableModels.join(", ")}`
    );
  }
  return withOptionalContextWindow(
    { model: requestedModel, availableModels },
    modelInfos.find((model) => model.id === requestedModel)?.contextWindow
  );
}

function modelInfo(entry: Record<string, unknown>): ModelInfo | undefined {
  const id = optionalString(entry["id"]);
  if (id === undefined) {
    return undefined;
  }
  const contextWindow = findContextWindow(entry);
  return {
    id,
    ...optionalModelStatus(modelStatus(entry["status"])),
    ...(contextWindow === undefined ? {} : { contextWindow })
  };
}

function optionalModelStatus(status: ModelStatus | undefined): { readonly status?: ModelStatus } {
  return status === undefined ? {} : { status };
}

function modelStatus(value: unknown): ModelStatus | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const status = optionalString((value as Record<string, unknown>)["value"]);
  return status === "loaded" || status === "unloaded" ? status : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

// llama.cpp serves /props at the server root, while the OpenAI-compatible API
// lives under /v1. Strip that one trailing segment when building the props URL.
function serverRootUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}

function withOptionalContextWindow<T extends Record<string, unknown>>(
  value: T,
  contextWindow: number | undefined
): T & { readonly contextWindow?: number } {
  if (contextWindow === undefined) {
    return value;
  }
  return { ...value, contextWindow };
}

function findContextWindow(entry: Record<string, unknown>): number | undefined {
  for (const key of [
    "context_window",
    "contextWindow",
    "context_length",
    "contextLength",
    "max_context_length",
    "maxContextLength",
    "n_ctx",
    "max_input_tokens",
    "maxInputTokens"
  ]) {
    const value = positiveInteger(entry[key]);
    if (value !== undefined) {
      return value;
    }
  }
  for (const key of ["metadata", "meta"]) {
    const nested = entry[key];
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      const found = findContextWindow(nested as Record<string, unknown>);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^[1-9]\d*$/u.test(value)) {
    return Number.parseInt(value, 10);
  }
  return undefined;
}
