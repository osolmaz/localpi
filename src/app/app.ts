import { readFile } from "node:fs/promises";

import { fail, ok, type CommandResult } from "../common/result.js";
import { searchGitcrawl, type SearchOptions, type SearchResult } from "../gitcrawl/search.js";
import { complete, listModels, normalizeBaseUrl, resolveModel } from "../llm/openai.js";
import type { ChatMessage } from "../llm/types.js";

export type SearchKind = SearchOptions["kind"];
export type SearchState = SearchOptions["state"];
export type SearchCommandOptions = SearchOptions;

export type ModelsOptions = {
  readonly baseUrl: string;
  readonly timeoutMs: number;
};

export type RunOptions = ModelsOptions & {
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly promptFile: string;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly json: boolean;
};

export async function models(options: ModelsOptions): Promise<CommandResult> {
  const ids = await listModels(options.baseUrl, options.timeoutMs);
  return ok(ids.map((id) => `${id}\n`).join(""));
}

export async function runPrompt(options: RunOptions): Promise<CommandResult> {
  const prompt = await readPrompt(options);
  const model = await resolveModel(options.baseUrl, options.model, options.timeoutMs);
  const messages = buildMessages(options.system, prompt);
  const result = await complete({
    baseUrl: options.baseUrl,
    model,
    messages,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    timeoutMs: options.timeoutMs
  });
  if (options.json) {
    return ok(`${JSON.stringify(result, null, 2)}\n`);
  }
  return ok(`${result.content.trim()}\n`);
}

export async function gitcrawlSearch(
  options: SearchOptions,
  format: "text" | "json" | "jsonl"
): Promise<CommandResult> {
  const results = await searchGitcrawl(options);
  if (format === "json") {
    return ok(`${JSON.stringify(results, null, 2)}\n`);
  }
  if (format === "jsonl") {
    return ok(results.map((result) => JSON.stringify(result)).join("\n") + "\n");
  }
  return ok(renderTextResults(results));
}

export function usage(): string {
  return `${[
    "usage:",
    "  localagent models [--base-url <url>]",
    "  localagent run --prompt <text> [--model <id|auto>] [--base-url <url>]",
    "  localagent run --prompt-file <path> [--model <id|auto>] [--base-url <url>]",
    "  localagent search-gitcrawl [--db <path>] [--repo <owner/name>]",
    "",
    "defaults:",
    "  --base-url http://127.0.0.1:1234/v1",
    "  --model auto"
  ].join("\n")}\n`;
}

export function usageError(message: string): CommandResult {
  return fail(`${message}\n${usage()}`);
}

async function readPrompt(options: RunOptions): Promise<string> {
  if (options.prompt !== "") {
    return options.prompt;
  }
  if (options.promptFile !== "") {
    return await readFile(options.promptFile, "utf8");
  }
  throw new Error("run requires --prompt or --prompt-file");
}

function buildMessages(system: string, prompt: string): readonly ChatMessage[] {
  return system.trim() === ""
    ? [{ role: "user", content: prompt }]
    : [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ];
}

function renderTextResults(results: readonly SearchResult[]): string {
  return results
    .map((result) =>
      [
        `- #${String(result.number)} [${result.kind}] score=${String(result.score)} ${result.title}`,
        `  ${result.url}`,
        `  groups: ${result.matches.map((match) => match.group).join(", ")}`
      ].join("\n")
    )
    .join("\n");
}

export const defaults = {
  baseUrl: normalizeBaseUrl(process.env["LOCALAGENT_BASE_URL"] ?? "http://127.0.0.1:1234/v1"),
  model: process.env["LOCALAGENT_MODEL"] ?? "auto",
  dbPath: process.env["GITCRAWL_DB"] ?? "~/.config/gitcrawl/gitcrawl.db"
} as const;
