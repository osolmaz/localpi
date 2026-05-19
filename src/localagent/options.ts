import path from "node:path";

import { normalizeBaseUrl } from "../llm/openai.js";

export type LocalagentOptions = {
  readonly baseUrl: string;
  readonly model: string;
  readonly providerId: string;
  readonly stateDir: string;
  readonly sessionDir: string;
  readonly piCommand: string;
  readonly thinking: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly finalSchemaPath: string | undefined;
  readonly status: boolean;
  readonly forwardedArgs: readonly string[];
};

export function defaultOptions(): LocalagentOptions {
  const home = envString("HOME", ".");
  const stateDir = envString("LOCALAGENT_STATE_DIR", path.join(home, ".local/state/localagent"));
  return {
    baseUrl: normalizeBaseUrl(envString("LOCALAGENT_BASE_URL", "http://127.0.0.1:1234/v1")),
    model: envString("LOCALAGENT_MODEL", "auto"),
    providerId: envString("LOCALAGENT_PROVIDER_ID", "local-openai"),
    stateDir,
    sessionDir: defaultSessionDir(stateDir),
    piCommand: envString("LOCALAGENT_PI_CMD", "npx -y @earendil-works/pi-coding-agent@latest"),
    thinking: envString("LOCALAGENT_THINKING", "off"),
    contextWindow: envPositiveInteger("LOCALAGENT_CONTEXT_WINDOW", "65536"),
    maxTokens: envPositiveInteger("LOCALAGENT_MAX_TOKENS", "8192"),
    timeoutMs: envPositiveInteger("LOCALAGENT_TIMEOUT_MS", "3000"),
    finalSchemaPath: process.env["LOCALAGENT_FINAL_SCHEMA"],
    status: false,
    forwardedArgs: []
  };
}

export function parseLocalagentArgs(args: readonly string[]): LocalagentOptions {
  let options = defaultOptions();
  const forwardedArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--") {
      forwardedArgs.push(...args.slice(index + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") {
      return { ...options, forwardedArgs: ["--help"] };
    }
    const parsed = parseLocalagentFlag(options, args, index);
    if (parsed !== undefined) {
      options = parsed.options;
      index += parsed.advance;
      continue;
    }
    forwardedArgs.push(arg);
  }
  return { ...options, forwardedArgs };
}

export function usage(): string {
  return `${[
    "localagent - pi, automatically pointed at a local OpenAI-compatible model",
    "",
    "usage:",
    "  localagent [localagent options] [pi options/messages]",
    "",
    "localagent options:",
    "  --base-url <url>          local OpenAI-compatible endpoint",
    "  --model <id|auto>         model to use; auto selects the first /v1/models id",
    "  --status                  print local model and runtime config status",
    "  --provider-id <id>        generated Pi provider id",
    "  --state-dir <path>        localagent runtime state directory",
    "  --session-dir <path>      Pi session directory",
    "  --pi-command <command>    Pi launch command",
    "  --thinking <level>        Pi thinking level; default off",
    "  --context-window <n>      generated model context window",
    "  --max-tokens <n>          generated model max output tokens",
    "  --timeout-ms <n>          /v1/models probe timeout",
    "  --final-schema <path>     force final schema output; requires Pi -p/--print",
    "  --schema <path>           alias for --final-schema",
    "  -h, --help                show this help",
    "",
    "examples:",
    "  localagent --status",
    '  localagent -p "summarize this repo"',
    '  localagent --model gemma-local -p "write a long implementation plan"',
    "  localagent -- --help"
  ].join("\n")}\n`;
}

type ParseResult = {
  readonly options: LocalagentOptions;
  readonly advance: number;
};

function parseLocalagentFlag(
  options: LocalagentOptions,
  args: readonly string[],
  index: number
): ParseResult | undefined {
  const arg = args[index];
  if (arg === "--status") {
    return { options: { ...options, status: true }, advance: 0 };
  }
  return arg === undefined ? undefined : parseValueFlag(options, args, index, arg);
}

type OptionUpdater = (options: LocalagentOptions, value: string) => LocalagentOptions;

const valueFlagUpdaters: Readonly<Record<string, OptionUpdater>> = {
  "--base-url": (options, value) => ({ ...options, baseUrl: normalizeBaseUrl(value) }),
  "--model": (options, value) => ({ ...options, model: value }),
  "--provider-id": (options, value) => ({ ...options, providerId: value }),
  "--state-dir": (options, value) => ({ ...options, stateDir: value }),
  "--session-dir": (options, value) => ({ ...options, sessionDir: value }),
  "--pi-command": (options, value) => ({ ...options, piCommand: value }),
  "--thinking": (options, value) => ({ ...options, thinking: value }),
  "--context-window": (options, value) => ({
    ...options,
    contextWindow: parsePositiveInteger(value)
  }),
  "--max-tokens": (options, value) => ({ ...options, maxTokens: parsePositiveInteger(value) }),
  "--timeout-ms": (options, value) => ({ ...options, timeoutMs: parsePositiveInteger(value) }),
  "--final-schema": (options, value) => ({ ...options, finalSchemaPath: value }),
  "--schema": (options, value) => ({ ...options, finalSchemaPath: value })
};

function parseValueFlag(
  options: LocalagentOptions,
  args: readonly string[],
  index: number,
  flag: string
): ParseResult | undefined {
  const updater = valueFlagUpdaters[flag];
  if (updater === undefined) {
    return undefined;
  }
  return { options: updater(options, requiredValue(args, index + 1, flag)), advance: 1 };
}

function envString(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function envPositiveInteger(name: string, fallback: string): number {
  return parsePositiveInteger(envString(name, fallback));
}

function defaultSessionDir(stateDir: string): string {
  return envString(
    "LOCALAGENT_SESSION_DIR",
    envString("PI_CODING_AGENT_SESSION_DIR", path.join(stateDir, "sessions"))
  );
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`expected a positive integer, got ${value}`);
  }
  return Number.parseInt(value, 10);
}
