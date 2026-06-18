import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { asObject, optionalString, requiredString } from "../common/json.js";
import { normalizeBaseUrl } from "../llm/openai.js";
import type { CatalogThinkingFormat } from "./catalog.js";
import type { LocalpiOptions } from "./options.js";

export type LocalModelProfile = {
  readonly id: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly client?: {
    readonly contextWindow?: number;
    readonly maxTokens?: number;
  };
  readonly capabilities?: {
    readonly reasoning?: boolean;
    readonly thinkingFormat?: CatalogThinkingFormat;
  };
};

export async function loadLocalModelProfile(
  options: LocalpiOptions
): Promise<LocalModelProfile | undefined> {
  if (options.modelProfileFile === undefined) {
    return undefined;
  }
  const raw = await readFile(expandHome(options.modelProfileFile), "utf8");
  return parseLocalModelProfile(JSON.parse(raw) as unknown, options.modelProfileFile);
}

export function profileMatchesModel(profile: LocalModelProfile, modelId: string): boolean {
  return modelId === profile.model || modelId === profile.id;
}

export function profileMatchesBaseUrl(profile: LocalModelProfile, baseUrl: string): boolean {
  return (
    profile.baseUrl === undefined || normalizeBaseUrl(profile.baseUrl) === normalizeBaseUrl(baseUrl)
  );
}

function parseLocalModelProfile(value: unknown, source: string): LocalModelProfile {
  const root = asObject(value, `model profile ${source}`);
  const client = optionalObject(root["client"], `model profile ${source} client`);
  const capabilities = optionalObject(root["capabilities"], `model profile ${source} capabilities`);
  const contextWindow =
    client === undefined
      ? undefined
      : optionalPositiveInteger(
          client["context_window"],
          `model profile ${source} client.context_window`
        );
  const maxTokens =
    client === undefined
      ? undefined
      : optionalPositiveInteger(client["max_tokens"], `model profile ${source} client.max_tokens`);
  const reasoning =
    capabilities === undefined
      ? undefined
      : optionalBoolean(
          capabilities["reasoning"],
          `model profile ${source} capabilities.reasoning`
        );
  const thinkingFormat =
    capabilities === undefined
      ? undefined
      : optionalThinkingFormat(
          optionalString(capabilities["thinking_format"]),
          `model profile ${source} capabilities.thinking_format`
        );
  return withoutUndefined({
    id: requiredString(root["id"], `model profile ${source} id`),
    model: requiredString(root["model"], `model profile ${source} model`),
    baseUrl: optionalString(root["base_url"]),
    client:
      client === undefined
        ? undefined
        : (withoutUndefined({
            contextWindow,
            maxTokens
          }) as LocalModelProfile["client"]),
    capabilities:
      capabilities === undefined
        ? undefined
        : (withoutUndefined({
            reasoning,
            thinkingFormat
          }) as LocalModelProfile["capabilities"])
  }) as LocalModelProfile;
}

function optionalObject(
  value: unknown,
  context: string
): Readonly<Record<string, unknown>> | undefined {
  return value === undefined ? undefined : asObject(value, context);
}

function optionalBoolean(value: unknown, context: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${context} must be a boolean`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, context: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${context} must be a positive integer`);
  }
  return value;
}

function optionalThinkingFormat(
  value: string | undefined,
  context: string
): CatalogThinkingFormat | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "deepseek" || value === "qwen-chat-template") {
    return value;
  }
  throw new Error(`${context} must be deepseek or qwen-chat-template`);
}

function expandHome(value: string): string {
  const home = os.homedir();
  return value === "~" || value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  ) as Partial<T>;
}
