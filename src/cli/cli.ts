import {
  defaults,
  gitcrawlSearch,
  models,
  runPrompt,
  usage,
  usageError,
  type SearchCommandOptions,
  type SearchKind,
  type SearchState
} from "../app/app.js";
import { errorMessage, fail, type CommandResult } from "../common/result.js";

type Format = "text" | "json" | "jsonl";

export async function run(args: readonly string[]): Promise<CommandResult> {
  try {
    return await dispatch(args);
  } catch (error) {
    return fail(errorMessage(error));
  }
}

async function dispatch(args: readonly string[]): Promise<CommandResult> {
  const command = args[0];
  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    return { code: 0, stdout: usage(), stderr: "" };
  }
  switch (command) {
    case "models":
      return await models(parseModelsArgs(args.slice(1)));
    case "run":
      return await runPrompt(parseRunArgs(args.slice(1)));
    case "search-gitcrawl": {
      const parsed = parseSearchArgs(args.slice(1));
      return await gitcrawlSearch(parsed.options, parsed.format);
    }
    default:
      return usageError(`unknown command: ${command}`);
  }
}

function parseModelsArgs(args: readonly string[]): {
  readonly baseUrl: string;
  readonly timeoutMs: number;
} {
  const flags = parseFlags(args);
  rejectPositionals(flags.positionals, "models");
  return {
    baseUrl: flag(flags, "base-url", defaults.baseUrl),
    timeoutMs: parsePositiveInteger(flag(flags, "timeout-ms", "3000"), "--timeout-ms")
  };
}

function parseRunArgs(args: readonly string[]) {
  const flags = parseFlags(args);
  rejectPositionals(flags.positionals, "run");
  return {
    baseUrl: flag(flags, "base-url", defaults.baseUrl),
    timeoutMs: parsePositiveInteger(flag(flags, "timeout-ms", "120000"), "--timeout-ms"),
    model: flag(flags, "model", defaults.model),
    system: flag(flags, "system", ""),
    prompt: flag(flags, "prompt", ""),
    promptFile: flag(flags, "prompt-file", ""),
    maxTokens: parsePositiveInteger(flag(flags, "max-tokens", "1024"), "--max-tokens"),
    temperature: parseFloatFlag(flag(flags, "temperature", "0.7"), "--temperature"),
    json: booleanFlag(flags, "json")
  };
}

function parseSearchArgs(args: readonly string[]): {
  readonly options: SearchCommandOptions;
  readonly format: Format;
} {
  const flags = parseFlags(args);
  rejectPositionals(flags.positionals, "search-gitcrawl");
  const taxonomyPath = optionalFlag(flags, "taxonomy");
  const options: SearchCommandOptions = {
    dbPath: expandHome(flag(flags, "db", defaults.dbPath)),
    repo: flag(flags, "repo", "openclaw/openclaw"),
    kind: parseKind(flag(flags, "kind", "all")),
    state: parseState(flag(flags, "state", "open")),
    minScore: parseNonNegativeInteger(flag(flags, "min-score", "14"), "--min-score"),
    limit: parsePositiveInteger(flag(flags, "limit", "50"), "--limit"),
    ...(taxonomyPath === undefined ? {} : { taxonomyPath })
  };
  return {
    format: parseFormat(flag(flags, "format", "text")),
    options
  };
}

type ParsedFlags = {
  readonly values: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
  readonly positionals: readonly string[];
};

function parseFlags(args: readonly string[]): ParsedFlags {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name === "json") {
      booleans.add(name);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    values.set(name, value);
    index += 1;
  }
  return { values, booleans, positionals };
}

function flag(flags: ParsedFlags, name: string, fallback: string): string {
  return flags.values.get(name) ?? fallback;
}

function optionalFlag(flags: ParsedFlags, name: string): string | undefined {
  return flags.values.get(name);
}

function booleanFlag(flags: ParsedFlags, name: string): boolean {
  return flags.booleans.has(name);
}

function rejectPositionals(positionals: readonly string[], command: string): void {
  if (positionals.length > 0) {
    throw new Error(`${command} received unexpected positional argument: ${positionals[0] ?? ""}`);
  }
}

function parseKind(value: string): SearchKind {
  if (value === "issue" || value === "pull_request" || value === "all") {
    return value;
  }
  throw new Error("--kind must be issue, pull_request, or all");
}

function parseState(value: string): SearchState {
  if (value === "open" || value === "closed" || value === "all") {
    return value;
  }
  throw new Error("--state must be open, closed, or all");
}

function parseFormat(value: string): Format {
  if (value === "text" || value === "json" || value === "jsonl") {
    return value;
  }
  throw new Error("--format must be text, json, or jsonl");
}

function parsePositiveInteger(value: string, flagName: string): number {
  const parsed = parseNonNegativeInteger(value, flagName);
  if (parsed === 0) {
    throw new Error(`${flagName} must be greater than zero`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, flagName: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`${flagName} must be an integer`);
  }
  return Number.parseInt(value, 10);
}

function parseFloatFlag(value: string, flagName: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flagName} must be a number`);
  }
  return parsed;
}

function expandHome(value: string): string {
  if (value === "~") {
    return process.env["HOME"] ?? value;
  }
  if (value.startsWith("~/")) {
    const home = process.env["HOME"];
    return home === undefined ? value : `${home}/${value.slice(2)}`;
  }
  return value;
}
