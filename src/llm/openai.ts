import { asArray, asObject, optionalString, requiredString } from "../common/json.js";
import type { ChatMessage, CompletionOptions, CompletionResult } from "./types.js";

type Fetcher = typeof fetch;

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/u, "");
}

export async function listModels(
  baseUrl: string,
  timeoutMs = 3000,
  fetcher: Fetcher = fetch
): Promise<readonly string[]> {
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
    .map((entry) => optionalString(asObject(entry, "model entry")["id"]))
    .filter((id): id is string => id !== undefined);
}

export async function resolveModel(
  baseUrl: string,
  requestedModel: string,
  timeoutMs = 3000,
  fetcher: Fetcher = fetch
): Promise<string> {
  if (requestedModel !== "auto") {
    return requestedModel;
  }
  const models = await listModels(baseUrl, timeoutMs, fetcher);
  const model = models[0];
  if (model === undefined) {
    throw new Error(`no models returned by ${normalizeBaseUrl(baseUrl)}/models`);
  }
  return model;
}

export async function complete(
  options: CompletionOptions,
  fetcher: Fetcher = fetch
): Promise<CompletionResult> {
  const messages: readonly ChatMessage[] = options.messages;
  const body = {
    model: options.model,
    messages,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    stream: false
  };
  const response = await fetcher(`${normalizeBaseUrl(options.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `completion failed with HTTP ${String(response.status)}: ${text.slice(0, 500)}`
    );
  }
  const payload: unknown = await response.json();
  const root = asObject(payload, "completion response");
  const choices = asArray(root["choices"], "completion choices");
  const first = choices[0];
  if (first === undefined) {
    throw new Error("completion response had no choices");
  }
  const choice = asObject(first, "completion choice");
  const message = asObject(choice["message"], "completion message");
  return {
    model: optionalString(root["model"]) ?? options.model,
    content: requiredString(message["content"], "completion content")
  };
}
