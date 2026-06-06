import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { asObject, optionalString } from "../common/json.js";

export type ModelAlias = {
  readonly name: string;
  readonly id: string;
  readonly paths: readonly string[];
  readonly contextWindow?: number;
  readonly chatTemplates?: readonly string[];
};

export type ModelAliasSummary = {
  readonly name: string;
  readonly id: string;
  readonly paths: readonly string[];
  readonly contextWindow?: number;
};

export type ResolvedLlamaModel = {
  readonly source: "alias" | "path";
  readonly name: string;
  readonly id: string;
  readonly modelPath: string;
  readonly contextWindow?: number;
  readonly chatTemplate?: string;
};

export async function listModelAliases(home = os.homedir()): Promise<readonly ModelAliasSummary[]> {
  return (await allAliases(home)).map((alias) => ({
    name: alias.name,
    id: alias.id,
    paths: alias.paths,
    ...(alias.contextWindow === undefined ? {} : { contextWindow: alias.contextWindow })
  }));
}

export async function findModelAlias(
  name: string,
  home = os.homedir()
): Promise<ModelAlias | undefined> {
  return (await allAliases(home)).find((entry) => entry.name === name);
}

export async function resolveLlamaModel(
  requested: string,
  chatTemplateOverride?: string,
  home = os.homedir()
): Promise<ResolvedLlamaModel> {
  const expanded = expandHome(requested, home);
  if (isGgufPath(expanded)) {
    return customPathModel(expanded, chatTemplateOverride);
  }
  const alias = (await allAliases(home)).find((entry) => entry.name === requested);
  if (alias === undefined) {
    throw new Error(
      `unknown llama-server model alias ${requested}; pass a GGUF path or use --list`
    );
  }
  const modelPath = await firstExisting(
    alias.paths.map((candidate) => expandHome(candidate, home))
  );
  if (modelPath === undefined) {
    throw new Error(
      `model alias ${requested} has no installed GGUF; checked: ${alias.paths.join(", ")}`
    );
  }
  return {
    source: "alias",
    name: alias.name,
    id: alias.id,
    modelPath,
    ...(alias.contextWindow === undefined ? {} : { contextWindow: alias.contextWindow }),
    ...optionalChatTemplate(
      chatTemplateOverride ??
        (await firstExisting((alias.chatTemplates ?? []).map(expandTemplate(home))))
    )
  };
}

export function defaultLlamaModelName(): string {
  return "gemma-12b";
}

function customPathModel(modelPath: string, chatTemplate?: string): ResolvedLlamaModel {
  return {
    source: "path",
    name: path.basename(modelPath, path.extname(modelPath)),
    id: modelIdFromPath(modelPath),
    modelPath,
    ...optionalChatTemplate(chatTemplate)
  };
}

async function allAliases(home: string): Promise<readonly ModelAlias[]> {
  return [...(await configuredAliases(home)), ...builtInAliases(home)];
}

async function configuredAliases(home: string): Promise<readonly ModelAlias[]> {
  const configPath = process.env["LOCALPI_MODELS_FILE"];
  if (configPath === undefined) {
    return [];
  }
  const raw = await readFile(expandHome(configPath, home), "utf8");
  const root = asObject(JSON.parse(raw) as unknown, "model alias config");
  const models = asObject(root["models"], "model alias config models");
  return Object.entries(models).map(([name, value]) => configuredAlias(name, value, home));
}

function configuredAlias(name: string, value: unknown, home: string): ModelAlias {
  const entry = asObject(value, `model alias ${name}`);
  const id = optionalString(entry["id"]) ?? name;
  const primaryPath = optionalString(entry["path"]);
  const paths = optionalStringArray(entry["paths"]);
  const allPaths = [primaryPath, ...paths].filter(
    (candidate): candidate is string => candidate !== undefined
  );
  if (allPaths.length === 0) {
    throw new Error(`model alias ${name} must define path or paths`);
  }
  return {
    name,
    id,
    paths: allPaths.map((candidate) => expandHome(candidate, home)),
    ...optionalContextWindow(optionalPositiveInteger(entry["contextWindow"])),
    chatTemplates: optionalStringArray(
      entry["chatTemplates"],
      optionalString(entry["chatTemplate"])
    )
  };
}

function builtInAliases(home: string): readonly ModelAlias[] {
  return [
    {
      name: "gemma-12b",
      id: "gemma-4-12b-it",
      paths: [
        "~/.lmstudio/models/lmstudio-community/gemma-4-12B-it-GGUF/gemma-4-12B-it-Q4_K_M.gguf",
        "~/.lmstudio/models/unsloth/gemma-4-12b-it-GGUF/gemma-4-12b-it-Q4_K_M.gguf"
      ],
      contextWindow: 32768,
      chatTemplates: [
        "~/scratch/gemma12b-chat-template-efficiency/templates/source/gemma4-12b-lmstudio.jinja"
      ]
    },
    {
      name: "gemma-e4b",
      id: "gemma-4-e4b-it",
      paths: ["~/.lmstudio/models/ggml-org/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-bf16.gguf"],
      contextWindow: 32768,
      chatTemplates: [
        "~/scratch/gemma12b-chat-template-efficiency/templates/source/gemma4-e4b.jinja"
      ]
    },
    {
      name: "gemma-e2b",
      id: "gemma-4-e2b-it",
      paths: ["~/.lmstudio/models/ggml-org/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q8_0.gguf"],
      contextWindow: 32768,
      chatTemplates: [
        "~/scratch/gemma12b-chat-template-efficiency/templates/source/gemma4-e4b.jinja"
      ]
    }
  ].map((alias) => ({
    ...alias,
    paths: alias.paths.map((candidate) => expandHome(candidate, home)),
    chatTemplates: alias.chatTemplates.map((candidate) => expandHome(candidate, home))
  }));
}

function optionalStringArray(value: unknown, first?: string): readonly string[] {
  const rest =
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? (value as readonly string[])
      : [];
  return first === undefined ? rest : [first, ...rest];
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function expandTemplate(home: string): (candidate: string) => string {
  return (candidate) => expandHome(candidate, home);
}

function expandHome(value: string, home: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

function isGgufPath(value: string): boolean {
  return value.endsWith(".gguf") || value.includes("/") || value.includes("\\");
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

async function firstExisting(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function modelIdFromPath(modelPath: string): string {
  return path.basename(modelPath, path.extname(modelPath)).replaceAll(/\s+/gu, "-").toLowerCase();
}
