import { asArray, asObject, optionalString } from "../common/json.js";

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

export async function resolveLocalModel(
  baseUrl: string,
  requestedModel: string,
  timeoutMs = 3000,
  fetcher: Fetcher = fetch
): Promise<{ readonly model: string; readonly availableModels: readonly string[] }> {
  const availableModels = await listModels(baseUrl, timeoutMs, fetcher);
  if (requestedModel === "auto") {
    const first = availableModels[0];
    if (first === undefined) {
      throw new Error(`no models returned by ${normalizeBaseUrl(baseUrl)}/models`);
    }
    return { model: first, availableModels };
  }
  if (availableModels.length > 0 && !availableModels.includes(requestedModel)) {
    throw new Error(
      `model ${requestedModel} is not reported by ${normalizeBaseUrl(baseUrl)}/models; available: ${availableModels.join(", ")}`
    );
  }
  return { model: requestedModel, availableModels };
}
