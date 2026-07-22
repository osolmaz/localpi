import path from "node:path";

import { normalizeBaseUrl } from "../llm/openai.js";

export type RuntimeKind = "auto" | "llama-server" | "lmstudio" | "vllm" | "openai-compatible";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ModelThinkingFormat = "deepseek" | "qwen-chat-template";

export const thinkingLevels: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
];

export type LocalpiOptions = {
  readonly runtime: RuntimeKind;
  readonly baseUrl: string | undefined;
  readonly model: string | undefined;
  readonly provider: string | undefined;
  readonly customProviderId: string;
  readonly providersFile: string | undefined;
  readonly modelProfileFile: string | undefined;
  readonly modelReasoning: boolean | undefined;
  readonly modelThinkingFormat: ModelThinkingFormat | undefined;
  readonly stateDir: string;
  readonly sessionDir: string;
  readonly piCommand: string;
  readonly thinking: ThinkingLevel;
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
  readonly diffusionCanvas: boolean;
  readonly demo: boolean;
  readonly demoFromCli: boolean;
  readonly demoInitialPrompt: string | undefined;
  readonly demoInitialPromptFile: string | undefined;
  readonly demoFollowupPrompt: string | undefined;
  readonly demoFollowupPromptFile: string | undefined;
  readonly status: boolean;
  readonly stop: boolean;
  readonly list: boolean;
  readonly forwardedArgs: readonly string[];
};

export function defaultOptions(): LocalpiOptions {
  const home = envString("HOME", ".");
  const stateDir = envString("LOCALPI_STATE_DIR", path.join(home, ".local/state/localpi"));
  return {
    runtime: parseRuntime(envString("LOCALPI_RUNTIME", "auto")),
    baseUrl: envOptionalBaseUrl("LOCALPI_BASE_URL"),
    model: process.env["LOCALPI_MODEL"],
    provider: process.env["LOCALPI_PROVIDER"],
    customProviderId: envString("LOCALPI_PROVIDER_ID", "local-openai"),
    providersFile: process.env["LOCALPI_PROVIDERS_FILE"],
    modelProfileFile:
      process.env["LOCALPI_MODEL_PROFILE"] ?? process.env["LOCALPAGER_AGENT_PROFILE"],
    modelReasoning: envOptionalBoolean("LOCALPI_MODEL_REASONING", "LOCALPAGER_AGENT_REASONING"),
    modelThinkingFormat: envOptionalThinkingFormat(
      "LOCALPI_MODEL_THINKING_FORMAT",
      "LOCALPAGER_AGENT_THINKING_FORMAT"
    ),
    stateDir,
    sessionDir: defaultSessionDir(stateDir),
    piCommand: envString("LOCALPI_PI_CMD", "npx -y @earendil-works/pi-coding-agent@latest"),
    thinking: parseThinkingLevel(envString("LOCALPI_THINKING", "medium")),
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
    diffusionCanvas: envBoolean("LOCALPI_DIFFUSION_CANVAS", false),
    demo: envBoolean("LOCALPI_DEMO", false),
    demoFromCli: false,
    demoInitialPrompt: process.env["LOCALPI_DEMO_INITIAL_PROMPT"],
    demoInitialPromptFile: process.env["LOCALPI_DEMO_INITIAL_PROMPT_FILE"],
    demoFollowupPrompt: process.env["LOCALPI_DEMO_FOLLOWUP_PROMPT"],
    demoFollowupPromptFile: process.env["LOCALPI_DEMO_FOLLOWUP_PROMPT_FILE"],
    status: false,
    stop: false,
    list: false,
    forwardedArgs: []
  };
}

export function parseLocalpiArgs(args: readonly string[]): LocalpiOptions {
  let options = defaultOptions();
  const forwardedArgs: string[] = [];
  const demoPromptFlags = demoPromptFlagTracker();
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
    trackDemoPromptFlag(demoPromptFlags, arg);
    const parsed = parseLocalpiFlag(options, args, index);
    if (parsed !== undefined) {
      options = parsed.options;
      index += parsed.advance;
      continue;
    }
    forwardedArgs.push(arg);
  }
  return normalizeDemoPromptPrecedence({ ...options, forwardedArgs }, demoPromptFlags);
}

export function usage(): string {
  return `${[
    "localpi - Pi, automatically pointed at a local model",
    "",
    "usage:",
    "  localpi [localpi options] [pi options/messages]",
    "  localpi grid --concurrency <n> [options] [-- command...]",
    "  localpi record --session <name> --out <file.mp4> [options]",
    "",
    "subcommands:",
    "  grid                    launch a tmux grid of concurrent demo panes",
    "                          (see localpi grid --help)",
    "  record                  record a tmux session in a themed Ghostty window",
    "                          (see localpi record --help)",
    "",
    "localpi options:",
    "  --runtime <kind>         auto, llama-server, lmstudio, vllm, or openai-compatible",
    "  --provider <id>          catalog provider id to use",
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
    "  --providers-file <path>  localpi provider registry JSON",
    "  --model-profile <path>   local model capability profile JSON",
    "  --model-reasoning <bool> override generated Pi reasoning capability",
    "  --model-thinking-format <format>",
    "                          override generated Pi thinking format",
    "  --no-approval           do not ask before tool calls",
    "  --no-token-status       do not install token status extension",
    "  --diffusion-canvas      show a diffusion canvas visualizer widget",
    "  --no-diffusion-canvas   disable the diffusion canvas visualizer",
    "  --demo                  endlessly run Pi prompts for demo mode",
    "  --demo-initial-prompt <text>",
    "                          first demo prompt",
    "  --demo-followup-prompt <text>",
    "                          repeated demo prompt after the first run",
    "  --demo-initial-prompt-file <path>",
    "                          UTF-8 file for the first demo prompt",
    "  --demo-followup-prompt-file <path>",
    "                          UTF-8 file for repeated demo prompts",
    "  --status                print runtime status and exit",
    "  --stop                  stop the localpi-owned llama-server",
    "  --list                  list model aliases",
    "  --state-dir <path>      localpi runtime state directory",
    "  --session-dir <path>    Pi session directory",
    "  --pi-command <command>  Pi launch command",
    "  --thinking <level>      thinking level: off, minimal, low, medium, high, xhigh",
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
    "  localpi -- --help",
    "  localpi grid -n 16 --allow-high-concurrency --start -- localpi --demo --model gemma4-26b",
    "  localpi record --session pi-demo-20260722-153000 --out demo.mp4"
  ].join("\n")}\n`;
}

type ParseResult = {
  readonly options: LocalpiOptions;
  readonly advance: number;
};

type DemoPromptFlagTracker = {
  initialText: boolean;
  initialFile: boolean;
  followupText: boolean;
  followupFile: boolean;
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
  "--no-token-status": (options) => ({ ...options, tokenStatus: false }),
  "--diffusion-canvas": (options) => ({ ...options, diffusionCanvas: true }),
  "--no-diffusion-canvas": (options) => ({ ...options, diffusionCanvas: false }),
  "--demo": (options) => ({ ...options, demo: true, demoFromCli: true })
};

type OptionUpdater = (options: LocalpiOptions, value: string) => LocalpiOptions;

const valueFlagUpdaters: Readonly<Record<string, OptionUpdater>> = {
  "--runtime": (options, value) => ({ ...options, runtime: parseRuntime(value) }),
  "--base-url": (options, value) => ({ ...options, baseUrl: normalizeBaseUrl(value) }),
  "--model": (options, value) => ({ ...options, model: value }),
  "--provider": (options, value) => ({ ...options, provider: value }),
  "--provider-id": (options, value) => ({ ...options, customProviderId: value }),
  "--providers-file": (options, value) => ({ ...options, providersFile: value }),
  "--model-profile": (options, value) => ({ ...options, modelProfileFile: value }),
  "--model-reasoning": (options, value) => ({ ...options, modelReasoning: parseBoolean(value) }),
  "--model-thinking-format": (options, value) => ({
    ...options,
    modelThinkingFormat: parseModelThinkingFormat(value)
  }),
  "--state-dir": (options, value) => ({ ...options, stateDir: value }),
  "--session-dir": (options, value) => ({ ...options, sessionDir: value }),
  "--pi-command": (options, value) => ({ ...options, piCommand: value }),
  "--thinking": (options, value) => ({ ...options, thinking: parseThinkingLevel(value) }),
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
  "--tools": (options, value) => ({ ...options, tools: value }),
  "--demo-initial-prompt": (options, value) => ({ ...options, demoInitialPrompt: value }),
  "--demo-followup-prompt": (options, value) => ({ ...options, demoFollowupPrompt: value }),
  "--demo-initial-prompt-file": (options, value) => ({
    ...options,
    demoInitialPromptFile: value
  }),
  "--demo-followup-prompt-file": (options, value) => ({
    ...options,
    demoFollowupPromptFile: value
  })
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

function demoPromptFlagTracker(): DemoPromptFlagTracker {
  return {
    initialText: false,
    initialFile: false,
    followupText: false,
    followupFile: false
  };
}

function trackDemoPromptFlag(tracker: DemoPromptFlagTracker, arg: string): void {
  switch (arg) {
    case "--demo-initial-prompt":
      tracker.initialText = true;
      return;
    case "--demo-initial-prompt-file":
      tracker.initialFile = true;
      return;
    case "--demo-followup-prompt":
      tracker.followupText = true;
      return;
    case "--demo-followup-prompt-file":
      tracker.followupFile = true;
      return;
  }
}

function normalizeDemoPromptPrecedence(
  options: LocalpiOptions,
  tracker: DemoPromptFlagTracker
): LocalpiOptions {
  return {
    ...options,
    demoInitialPromptFile:
      tracker.initialText && !tracker.initialFile ? undefined : options.demoInitialPromptFile,
    demoFollowupPromptFile:
      tracker.followupText && !tracker.followupFile ? undefined : options.demoFollowupPromptFile
  };
}

function parseRuntime(value: string): RuntimeKind {
  if (
    value === "auto" ||
    value === "llama-server" ||
    value === "lmstudio" ||
    value === "vllm" ||
    value === "openai-compatible"
  ) {
    return value;
  }
  throw new Error(
    `unknown runtime ${value}; expected auto, llama-server, lmstudio, vllm, or openai-compatible`
  );
}

export function parseThinkingLevel(value: string): ThinkingLevel {
  for (const level of thinkingLevels) {
    if (value === level) {
      return level;
    }
  }
  throw new Error(
    `unknown thinking level ${value}; expected off, minimal, low, medium, high, or xhigh`
  );
}

function parseModelThinkingFormat(value: string): ModelThinkingFormat {
  if (value === "deepseek" || value === "qwen-chat-template") {
    return value;
  }
  throw new Error(
    `unknown model thinking format ${value}; expected deepseek or qwen-chat-template`
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

function envOptionalBoolean(primaryName: string, fallbackName: string): boolean | undefined {
  const [name, value] = envFirst([primaryName, fallbackName]);
  return value === undefined ? undefined : parseBoolean(value, name);
}

function envOptionalThinkingFormat(
  primaryName: string,
  fallbackName: string
): ModelThinkingFormat | undefined {
  const [, value] = envFirst([primaryName, fallbackName]);
  return value === undefined ? undefined : parseModelThinkingFormat(value);
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return parseBoolean(value, name);
}

function parseBoolean(value: string, name = "value"): boolean {
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) {
    return false;
  }
  throw new Error(`${name} must be boolean-like, got ${value}`);
}

function envFirst(names: readonly string[]): readonly [string, string | undefined] {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) {
      return [name, value];
    }
  }
  return [names[0] ?? "", undefined];
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
