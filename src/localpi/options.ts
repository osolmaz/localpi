import path from "node:path";

import { normalizeBaseUrl } from "../llm/openai.js";

export type RuntimeKind = "llama-server" | "lmstudio" | "openai-compatible";

export type LocalpiOptions = {
  readonly runtime: RuntimeKind;
  readonly baseUrl: string | undefined;
  readonly model: string | undefined;
  readonly providerId: string;
  readonly stateDir: string;
  readonly sessionDir: string;
  readonly piCommand: string;
  readonly thinking: string;
  readonly contextWindow: number | undefined;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly serverCommand: string;
  readonly host: string;
  readonly port: number;
  readonly gpuLayers: number;
  readonly parallel: number;
  readonly chatTemplate: string | undefined;
  readonly tools: string | undefined;
  readonly approval: boolean;
  readonly tokenStatus: boolean;
  readonly status: boolean;
  readonly stop: boolean;
  readonly list: boolean;
  readonly forwardedArgs: readonly string[];
};

export function defaultOptions(): LocalpiOptions {
  const home = envString("HOME", ".");
  const stateDir = envString("LOCALPI_STATE_DIR", path.join(home, ".local/state/localpi"));
  return {
    runtime: parseRuntime(envString("LOCALPI_RUNTIME", "llama-server")),
    baseUrl: envOptionalBaseUrl("LOCALPI_BASE_URL"),
    model: process.env["LOCALPI_MODEL"],
    providerId: envString("LOCALPI_PROVIDER_ID", "local-openai"),
    stateDir,
    sessionDir: defaultSessionDir(stateDir),
    piCommand: envString("LOCALPI_PI_CMD", "npx -y @earendil-works/pi-coding-agent@latest"),
    thinking: envString("LOCALPI_THINKING", "off"),
    contextWindow: envOptionalPositiveInteger("LOCALPI_CONTEXT_WINDOW"),
    maxTokens: envPositiveInteger("LOCALPI_MAX_TOKENS", "8192"),
    timeoutMs: envPositiveInteger("LOCALPI_TIMEOUT_MS", "3000"),
    serverCommand: envString("LOCALPI_LLAMA_SERVER", "llama-server"),
    host: envString("LOCALPI_HOST", "127.0.0.1"),
    port: envPositiveInteger("LOCALPI_PORT", "18194"),
    gpuLayers: envNonNegativeInteger("LOCALPI_GPU_LAYERS", "999"),
    parallel: envPositiveInteger("LOCALPI_PARALLEL", "1"),
    chatTemplate: process.env["LOCALPI_CHAT_TEMPLATE"],
    tools: envString("LOCALPI_TOOLS", "read,bash,edit,write,grep,find,ls"),
    approval: envBoolean("LOCALPI_APPROVAL", true),
    tokenStatus: envBoolean("LOCALPI_TOKEN_STATUS", true),
    status: false,
    stop: false,
    list: false,
    forwardedArgs: []
  };
}

export function parseLocalpiArgs(args: readonly string[]): LocalpiOptions {
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
    const parsed = parseLocalpiFlag(options, args, index);
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
    "localpi - Pi, automatically pointed at a local model",
    "",
    "usage:",
    "  localpi [localpi options] [pi options/messages]",
    "",
    "localpi options:",
    "  --runtime <kind>         llama-server, lmstudio, or openai-compatible",
    "  --model <alias|id|path>  model alias, backend id, or GGUF path",
    "  --base-url <url>         OpenAI-compatible endpoint",
    "  --ctx <n>                model context window",
    "  --context-window <n>     alias for --ctx",
    "  --max-tokens <n>         generated model max output tokens",
    "  --server-command <path>  llama-server executable",
    "  --llama-server <path>    alias for --server-command",
    "  --host <host>            managed llama-server host",
    "  --port <n>               managed llama-server port",
    "  --gpu-layers <n>         llama-server GPU layers",
    "  --parallel <n>           llama-server parallel slots",
    "  --chat-template <path>   llama.cpp chat template file",
    "  --tools <list>           Pi tools allow list",
    "  --no-approval           do not ask before tool calls",
    "  --no-token-status       do not install token status extension",
    "  --status                print runtime status and exit",
    "  --stop                  stop the localpi-owned llama-server",
    "  --list                  list model aliases",
    "  --state-dir <path>      localpi runtime state directory",
    "  --session-dir <path>    Pi session directory",
    "  --pi-command <command>  Pi launch command",
    "  --thinking <level>      Pi thinking level; default off",
    "  --timeout-ms <n>        backend probe timeout",
    "  -h, --help              show this help",
    "",
    "removed options:",
    "  --final-schema and --schema belong in localpager-agent, not localpi",
    "",
    "examples:",
    "  localpi --list",
    "  localpi --status",
    '  localpi --model gemma-e4b -p "say ok"',
    "  localpi --runtime lmstudio --model gemma-4-e4b-it",
    "  localpi -- --help"
  ].join("\n")}\n`;
}

type ParseResult = {
  readonly options: LocalpiOptions;
  readonly advance: number;
};

function parseLocalpiFlag(
  options: LocalpiOptions,
  args: readonly string[],
  index: number
): ParseResult | undefined {
  const arg = args[index];
  const booleanResult = arg === undefined ? undefined : parseBooleanFlag(options, arg);
  if (booleanResult !== undefined) {
    return booleanResult;
  }
  if (arg === "--schema" || arg === "--final-schema") {
    throw new Error(`${arg} was removed from localpi; use localpager-agent for schema output`);
  }
  return arg === undefined ? undefined : parseValueFlag(options, args, index, arg);
}

function parseBooleanFlag(options: LocalpiOptions, arg: string): ParseResult | undefined {
  const updater = booleanFlagUpdaters[arg];
  return updater === undefined ? undefined : { options: updater(options), advance: 0 };
}

type BooleanUpdater = (options: LocalpiOptions) => LocalpiOptions;

const booleanFlagUpdaters: Readonly<Record<string, BooleanUpdater>> = {
  "--status": (options) => ({ ...options, status: true }),
  "--stop": (options) => ({ ...options, stop: true }),
  "--list": (options) => ({ ...options, list: true }),
  "--no-approval": (options) => ({ ...options, approval: false }),
  "--no-token-status": (options) => ({ ...options, tokenStatus: false })
};

type OptionUpdater = (options: LocalpiOptions, value: string) => LocalpiOptions;

const valueFlagUpdaters: Readonly<Record<string, OptionUpdater>> = {
  "--runtime": (options, value) => ({ ...options, runtime: parseRuntime(value) }),
  "--base-url": (options, value) => ({ ...options, baseUrl: normalizeBaseUrl(value) }),
  "--model": (options, value) => ({ ...options, model: value }),
  "--provider-id": (options, value) => ({ ...options, providerId: value }),
  "--state-dir": (options, value) => ({ ...options, stateDir: value }),
  "--session-dir": (options, value) => ({ ...options, sessionDir: value }),
  "--pi-command": (options, value) => ({ ...options, piCommand: value }),
  "--thinking": (options, value) => ({ ...options, thinking: value }),
  "--ctx": (options, value) => ({ ...options, contextWindow: parsePositiveInteger(value) }),
  "--context-window": (options, value) => ({
    ...options,
    contextWindow: parsePositiveInteger(value)
  }),
  "--max-tokens": (options, value) => ({ ...options, maxTokens: parsePositiveInteger(value) }),
  "--timeout-ms": (options, value) => ({ ...options, timeoutMs: parsePositiveInteger(value) }),
  "--server-command": (options, value) => ({ ...options, serverCommand: value }),
  "--llama-server": (options, value) => ({ ...options, serverCommand: value }),
  "--host": (options, value) => ({ ...options, host: value }),
  "--port": (options, value) => ({ ...options, port: parsePositiveInteger(value) }),
  "--gpu-layers": (options, value) => ({ ...options, gpuLayers: parseNonNegativeInteger(value) }),
  "--parallel": (options, value) => ({ ...options, parallel: parsePositiveInteger(value) }),
  "--chat-template": (options, value) => ({ ...options, chatTemplate: value }),
  "--tools": (options, value) => ({ ...options, tools: value })
};

function parseValueFlag(
  options: LocalpiOptions,
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

function parseRuntime(value: string): RuntimeKind {
  if (value === "llama-server" || value === "lmstudio" || value === "openai-compatible") {
    return value;
  }
  throw new Error(
    `unknown runtime ${value}; expected llama-server, lmstudio, or openai-compatible`
  );
}

function envString(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function envOptionalBaseUrl(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined ? undefined : normalizeBaseUrl(value);
}

function envPositiveInteger(name: string, fallback: string): number {
  return parsePositiveInteger(envString(name, fallback));
}

function envNonNegativeInteger(name: string, fallback: string): number {
  return parseNonNegativeInteger(envString(name, fallback));
}

function envOptionalPositiveInteger(name: string): number | undefined {
  const value = process.env[name];
  return value === undefined ? undefined : parsePositiveInteger(value);
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) {
    return false;
  }
  throw new Error(`${name} must be boolean-like, got ${value}`);
}

function defaultSessionDir(stateDir: string): string {
  return envString(
    "LOCALPI_SESSION_DIR",
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

function parseNonNegativeInteger(value: string): number {
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`expected a non-negative integer, got ${value}`);
  }
  return Number.parseInt(value, 10);
}
