import path from "node:path";

import { normalizeBaseUrl } from "../llm/openai.js";
import { catppuccinFlavors, type CatppuccinFlavor } from "./catppuccin.js";

export type RuntimeKind =
  | "auto"
  | "llama-server"
  | "llama-cpp"
  | "lmstudio"
  | "vllm"
  | "openai-compatible";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ModelThinkingFormat = "deepseek" | "qwen-chat-template";
export type StatsMode = "off" | "line" | "full";
export type PermissionMode = "ask" | "allow";
export type SkillsMode = "own" | "ambient" | "off";
export type TuiMode = "regular" | "fullscreen";

export const statsModes: readonly StatsMode[] = ["off", "line", "full"];

export const skillsModes: readonly SkillsMode[] = ["own", "ambient", "off"];

export const permissionModes: readonly PermissionMode[] = ["ask", "allow"];

export const tuiModes: readonly TuiMode[] = ["regular", "fullscreen"];

export const defaultStopThinkingKey = "ctrl+shift+s";

// localpi launches Pi through npx, so a normal launch always runs the newest Pi release.
const defaultPiCommand = "npx -y @earendil-works/pi-coding-agent@latest";

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
  readonly apiKey: string;
  readonly model: string | undefined;
  readonly provider: string | undefined;
  readonly customProviderId: string;
  readonly providersFile: string | undefined;
  readonly modelProfileFile: string | undefined;
  readonly modelReasoning: boolean | undefined;
  readonly modelThinkingFormat: ModelThinkingFormat | undefined;
  readonly stateDir: string;
  readonly sessionDir: string;
  readonly piCommand: readonly string[];
  readonly thinking: ThinkingLevel;
  readonly thinkingBudget: number | undefined;
  readonly thinkingBudgetMessage: string | undefined;
  readonly thinkingPhaseOutputCap: number | undefined;
  readonly contextWindow: number | undefined;
  readonly maxTokens: number;
  readonly continueOnTruncation: number;
  readonly timeoutMs: number;
  readonly serverCommand: string;
  readonly host: string;
  readonly port: number;
  readonly gpuLayers: number;
  readonly parallel: number;
  readonly chatTemplate: string | undefined;
  readonly tools: string | undefined;
  readonly approval: boolean;
  readonly approveReadTools: boolean;
  readonly stats: StatsMode;
  readonly skills: SkillsMode;
  readonly tuiMode: TuiMode;
  readonly stopThinkingKey: string | undefined;
  readonly stopThinkingDelay: number;
  readonly demo: boolean;
  readonly demoFromCli: boolean;
  readonly demoInitialPrompt: string | undefined;
  readonly demoInitialPromptFile: string | undefined;
  readonly demoFollowupPrompt: string | undefined;
  readonly demoFollowupPromptFile: string | undefined;
  readonly acp: boolean;
  readonly acpFromCli: boolean;
  readonly web: boolean;
  readonly webPort: number;
  readonly webOpen: boolean;
  readonly webHost: string;
  readonly webAllowedHosts: readonly string[];
  readonly webTheme: CatppuccinFlavor;
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
    apiKey: envString("LOCALPI_API_KEY", "local"),
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
    piCommand: parsePiCommand(envString("LOCALPI_PI_CMD", defaultPiCommand)),
    thinking: parseThinkingLevel(envString("LOCALPI_THINKING", "medium")),
    thinkingBudget: envOptionalThinkingBudget("LOCALPI_THINKING_BUDGET"),
    thinkingBudgetMessage: process.env["LOCALPI_THINKING_BUDGET_MESSAGE"],
    thinkingPhaseOutputCap: envOptionalPositiveInteger("LOCALPI_THINKING_PHASE_OUTPUT_CAP"),
    contextWindow: envOptionalPositiveInteger("LOCALPI_CONTEXT_WINDOW"),
    maxTokens: envPositiveInteger("LOCALPI_MAX_TOKENS", "8192"),
    continueOnTruncation: envContinuationLimit("LOCALPI_CONTINUE_ON_TRUNCATION"),
    timeoutMs: envPositiveInteger("LOCALPI_TIMEOUT_MS", "3000"),
    serverCommand: envString("LOCALPI_LLAMA_SERVER", "llama-server"),
    host: envString("LOCALPI_HOST", "127.0.0.1"),
    port: envPositiveInteger("LOCALPI_PORT", "18194"),
    gpuLayers: envNonNegativeInteger("LOCALPI_GPU_LAYERS", "999"),
    parallel: envPositiveInteger("LOCALPI_PARALLEL", "1"),
    chatTemplate: process.env["LOCALPI_CHAT_TEMPLATE"],
    tools: envString("LOCALPI_TOOLS", "read,bash,edit,write,grep,find,ls"),
    approval: envBoolean("LOCALPI_APPROVAL", true),
    approveReadTools: envBoolean("LOCALPI_APPROVE_READ_TOOLS", false),
    stats: defaultStatsMode(),
    skills: parseSkillsMode(envString("LOCALPI_SKILLS", "own")),
    tuiMode: parseTuiMode(envString("LOCALPI_TUI_MODE", "fullscreen")),
    stopThinkingKey: parseStopThinkingKey(
      envString("LOCALPI_STOP_THINKING_KEY", defaultStopThinkingKey)
    ),
    stopThinkingDelay: parseStopThinkingDelay(envString("LOCALPI_STOP_THINKING_DELAY", "5")),
    demo: envBoolean("LOCALPI_DEMO", false),
    demoFromCli: false,
    demoInitialPrompt: process.env["LOCALPI_DEMO_INITIAL_PROMPT"],
    demoInitialPromptFile: process.env["LOCALPI_DEMO_INITIAL_PROMPT_FILE"],
    demoFollowupPrompt: process.env["LOCALPI_DEMO_FOLLOWUP_PROMPT"],
    demoFollowupPromptFile: process.env["LOCALPI_DEMO_FOLLOWUP_PROMPT_FILE"],
    acp: envBoolean("LOCALPI_ACP", false),
    acpFromCli: false,
    web: envBoolean("LOCALPI_WEB", false),
    webPort: envNonNegativeInteger("LOCALPI_WEB_PORT", "0"),
    webOpen: envBoolean("LOCALPI_WEB_OPEN", true),
    webHost: envString("LOCALPI_WEB_HOST", "127.0.0.1"),
    webAllowedHosts: parseHostList(envString("LOCALPI_WEB_ALLOWED_HOSTS", "")),
    webTheme: parseWebTheme(envString("LOCALPI_WEB_THEME", "latte")),
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
    "",
    "localpi options:",
    "  --runtime <kind>         auto, llama-server, llama-cpp, lmstudio, vllm, or openai-compatible",
    "  --provider <id>          catalog provider id to use",
    "  --model <alias|id|path>  model alias, backend id, or GGUF path",
    "  --base-url <url>         OpenAI-compatible endpoint",
    "  --api-key <value>        Pi provider API key: a literal, ${NAME}, or !command",
    "                          (LOCALPI_API_KEY=<value>, default: local)",
    "  --ctx <n>                model context window",
    "  --context-window <n>     alias for --ctx",
    "  --max-tokens <n>         generated model max output tokens",
    "  --continue-on-truncation <n>",
    "                          continue a reply cut off by the output limit, up to n times",
    "                          (LOCALPI_CONTINUE_ON_TRUNCATION=<n>)",
    "  --server-command <path>  llama-server executable",
    "  --llama-server <path>    alias for --server-command",
    "  --host <host>            managed llama-server host",
    "  --port <n>               managed llama-server port",
    "  --gpu-layers <n>         llama-server GPU layers",
    "  --parallel <n>           llama-server parallel slots",
    "  --chat-template <path>   llama.cpp chat template file",
    "  --tools <list>           Pi tools allow list",
    "  --stats <mode>           stats: off, line, or full (default: full)",
    "  --skills <mode>          skills: own, ambient, or off (default: own)",
    "  --stop-thinking-key <key>",
    "                          key that stops thinking and asks for the answer, or off",
    "                          (LOCALPI_STOP_THINKING_KEY=<key>, default: ctrl+shift+s)",
    "  --stop-thinking-delay <seconds>",
    "                          show the stop thinking button after this much thinking, 0 at once",
    "                          (LOCALPI_STOP_THINKING_DELAY=<seconds>, default: 5)",
    "  --providers-file <path>  localpi provider registry JSON",
    "  --model-profile <path>   local model capability profile JSON",
    "  --model-reasoning <bool> override generated Pi reasoning capability",
    "  --model-thinking-format <format>",
    "                          override generated Pi thinking format",
    "  --no-approval           start with tool approval off for this session",
    "  --approve-read-tools    also ask before read-only tools (read, grep, find, ls)",
    "  --no-token-status       alias for --stats off",
    "  --acp                   serve ACP on stdio through the pinned pi-acp adapter",
    "                          (LOCALPI_ACP=1); requires an explicit --model",
    "  --web                   run localpi in the browser: sessions and the Pi TUI (LOCALPI_WEB=1)",
    "  --web-port <n>          web mode port, 0 picks a free port (LOCALPI_WEB_PORT, default: 0)",
    "  --no-browser            do not open the browser in web mode (LOCALPI_WEB_OPEN=0)",
    "  --web-host <host>       web mode listen address, for example a Tailscale address",
    "                          (LOCALPI_WEB_HOST, default: 127.0.0.1)",
    "  --web-allowed-hosts <names>",
    "                          extra host names for the web page, comma-separated",
    "                          (LOCALPI_WEB_ALLOWED_HOSTS)",
    "  --web-theme <flavor>    web mode Catppuccin flavor: latte, frappe, macchiato, or mocha",
    "                          (LOCALPI_WEB_THEME, default: latte)",
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
    "  --pi-command <command>  Pi launch command, split on whitespace and quotes",
    "  --thinking <level>      thinking level: off, minimal, low, medium, high, xhigh",
    "  --thinking-budget <n>   managed llama-server thinking cap, -1 for unrestricted",
    "  --thinking-phase-output-cap <n>",
    "                          opt-in first-request output ceiling for llama.cpp/vLLM",
    "  --thinking-budget-message <text>",
    "                          text before the end-of-thinking tag; empty text passes none",
    "  --timeout-ms <n>        backend probe timeout",
    "  -h, --help              show this help",
    "",
    "removed options:",
    "  --final-schema and --schema belong in localpager-agent, not localpi",
    "",
    "examples:",
    "  localpi --list",
    "  localpi --status",
    '  localpi --model <name> -p "say ok"',
    "  localpi --runtime lmstudio --model <model-id>",
    "  localpi -- --help"
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
  "--approve-read-tools": (options) => ({ ...options, approveReadTools: true }),
  "--no-token-status": (options) => ({ ...options, stats: "off" }),
  "--no-skills": (options) => ({ ...options, skills: "off" }),
  "-ns": (options) => ({ ...options, skills: "off" }),
  "--acp": (options) => ({ ...options, acp: true, acpFromCli: true }),
  "--web": (options) => ({ ...options, web: true }),
  "--no-browser": (options) => ({ ...options, webOpen: false }),
  "--demo": (options) => ({ ...options, demo: true, demoFromCli: true })
};

type OptionUpdater = (options: LocalpiOptions, value: string) => LocalpiOptions;

const valueFlagUpdaters: Readonly<Record<string, OptionUpdater>> = {
  "--runtime": (options, value) => ({ ...options, runtime: parseRuntime(value) }),
  "--base-url": (options, value) => ({ ...options, baseUrl: normalizeBaseUrl(value) }),
  "--api-key": (options, value) => ({ ...options, apiKey: value }),
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
  "--pi-command": (options, value) => ({ ...options, piCommand: parsePiCommand(value) }),
  "--thinking": (options, value) => ({ ...options, thinking: parseThinkingLevel(value) }),
  "--thinking-budget": (options, value) => ({
    ...options,
    thinkingBudget: parseThinkingBudget(value)
  }),
  "--thinking-budget-message": (options, value) => ({
    ...options,
    thinkingBudgetMessage: value
  }),
  "--thinking-phase-output-cap": (options, value) => ({
    ...options,
    thinkingPhaseOutputCap: parsePositiveInteger(value)
  }),
  "--stats": (options, value) => ({ ...options, stats: parseStatsMode(value) }),
  "--skills": (options, value) => ({ ...options, skills: parseSkillsMode(value) }),
  "--stop-thinking-key": (options, value) => ({
    ...options,
    stopThinkingKey: parseStopThinkingKey(value)
  }),
  "--stop-thinking-delay": (options, value) => ({
    ...options,
    stopThinkingDelay: parseStopThinkingDelay(value)
  }),
  "--ctx": (options, value) => ({ ...options, contextWindow: parsePositiveInteger(value) }),
  "--context-window": (options, value) => ({
    ...options,
    contextWindow: parsePositiveInteger(value)
  }),
  "--max-tokens": (options, value) => ({ ...options, maxTokens: parsePositiveInteger(value) }),
  "--continue-on-truncation": (options, value) => ({
    ...options,
    continueOnTruncation: parsePositiveInteger(value)
  }),
  "--timeout-ms": (options, value) => ({ ...options, timeoutMs: parsePositiveInteger(value) }),
  "--server-command": (options, value) => ({ ...options, serverCommand: value }),
  "--llama-server": (options, value) => ({ ...options, serverCommand: value }),
  "--host": (options, value) => ({ ...options, host: value }),
  "--port": (options, value) => ({ ...options, port: parsePositiveInteger(value) }),
  "--web-port": (options, value) => ({ ...options, webPort: parseNonNegativeInteger(value) }),
  "--web-host": (options, value) => ({ ...options, webHost: value }),
  "--web-theme": (options, value) => ({ ...options, webTheme: parseWebTheme(value) }),
  "--web-allowed-hosts": (options, value) => ({
    ...options,
    webAllowedHosts: parseHostList(value)
  }),
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
    value === "llama-cpp" ||
    value === "lmstudio" ||
    value === "vllm" ||
    value === "openai-compatible"
  ) {
    return value;
  }
  throw new Error(
    `unknown runtime ${value}; expected auto, llama-server, llama-cpp, lmstudio, vllm, or openai-compatible`
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

/**
 * A thinking budget is -1 for unrestricted thinking, or a positive token count. Zero is rejected,
 * because the managed server reads it as an immediate end of thinking.
 */
export function parseThinkingBudget(value: string): number {
  if (/^[1-9]\d*$/u.test(value)) {
    return Number.parseInt(value, 10);
  }
  if (value === "-1") {
    return -1;
  }
  throw new Error(`unknown thinking budget ${value}; expected -1 or a positive integer`);
}

export function parseStatsMode(value: string): StatsMode {
  for (const mode of statsModes) {
    if (value === mode) {
      return mode;
    }
  }
  throw new Error(`unknown stats mode ${value}; expected off, line, or full`);
}

export function parseSkillsMode(value: string): SkillsMode {
  for (const mode of skillsModes) {
    if (value === mode) {
      return mode;
    }
  }
  throw new Error(`unknown skills mode ${value}; expected own, ambient, or off`);
}

export function parseTuiMode(value: string): TuiMode {
  for (const mode of tuiModes) {
    if (value === mode) {
      return mode;
    }
  }
  throw new Error(`unknown TUI mode ${value}; expected regular or fullscreen`);
}

const keyModifiers = new Set(["ctrl", "shift", "alt", "super"]);
const namedKeys = new Set([
  "escape",
  "esc",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageUp",
  "pageDown",
  "up",
  "down",
  "left",
  "right"
]);

/**
 * Read a key in Pi's shortcut format, such as `ctrl+shift+s`, or `off` for no key. A key must carry
 * at least one modifier, so a plain letter can never steal typed text from the editor.
 */
export function parseStopThinkingKey(value: string): string | undefined {
  if (value === "off") {
    return undefined;
  }
  const parts = value.split("+");
  const key = parts[parts.length - 1] ?? "";
  const modifiers = parts.slice(0, -1);
  const validModifiers =
    modifiers.length > 0 &&
    modifiers.every((modifier) => keyModifiers.has(modifier)) &&
    new Set(modifiers).size === modifiers.length;
  if (!validModifiers || !isShortcutKey(key)) {
    throw new Error(
      `unknown stop thinking key ${value}; expected off or a modified key such as ctrl+shift+s`
    );
  }
  return value;
}

/** Read the button delay in seconds. Zero shows the button as soon as the thinking starts. */
export function parseStopThinkingDelay(value: string): number {
  if (!/^(0|[1-9]\d*)(\.\d+)?$/u.test(value)) {
    throw new Error(
      `unknown stop thinking delay ${value}; expected a number of seconds, 0 or more`
    );
  }
  return Number.parseFloat(value);
}

function isShortcutKey(key: string): boolean {
  return (
    /^[a-z0-9]$/u.test(key) ||
    /^f([1-9]|1[0-2])$/u.test(key) ||
    namedKeys.has(key) ||
    /^[`\-=[\]\\;',./!@#$%^&*()_|~{}:<>?]$/u.test(key)
  );
}

export function parsePermissionMode(value: string): PermissionMode {
  for (const mode of permissionModes) {
    if (value === mode) {
      return mode;
    }
  }
  throw new Error(`unknown permission mode ${value}; expected ask or allow`);
}

/**
 * Split a Pi launch command into a program and its arguments. Quotes group words, so a quoted
 * argument stays one piece.
 */
export function parsePiCommand(value: string): readonly string[] {
  const parts = (value.match(/"[^"]*"|'[^']*'|\S+/gu) ?? []).map(unquotePiCommandPart);
  if (parts.length === 0) {
    throw new Error("Pi launch command must not be empty");
  }
  return parts;
}

function unquotePiCommandPart(part: string): string {
  const quote = part[0];
  const quoted = part.length > 1 && (quote === '"' || quote === "'");
  return quoted && part.endsWith(quote) ? part.slice(1, -1) : part;
}

function defaultStatsMode(): StatsMode {
  const explicit = process.env["LOCALPI_STATS"];
  if (explicit !== undefined) {
    return parseStatsMode(explicit);
  }
  return envBoolean("LOCALPI_TOKEN_STATUS", true) ? "full" : "off";
}

function parseModelThinkingFormat(value: string): ModelThinkingFormat {
  if (value === "deepseek" || value === "qwen-chat-template") {
    return value;
  }
  throw new Error(
    `unknown model thinking format ${value}; expected deepseek or qwen-chat-template`
  );
}

export function parseWebTheme(value: string): CatppuccinFlavor {
  for (const flavor of catppuccinFlavors) {
    if (value === flavor) {
      return flavor;
    }
  }
  throw new Error(`unknown web theme ${value}; expected latte, frappe, macchiato, or mocha`);
}

function parseHostList(value: string): readonly string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
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

/**
 * The continuation limit allows zero, because zero turns the feature off. An inherited
 * environment value must be disableable without dropping the variable.
 */
function envContinuationLimit(name: string): number {
  const value = process.env[name];
  if (value === undefined) {
    return 0;
  }
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`${name} must be a nonnegative integer, got ${value}`);
  }
  return Number.parseInt(value, 10);
}

function envOptionalThinkingBudget(name: string): number | undefined {
  const value = process.env[name];
  return value === undefined ? undefined : parseThinkingBudget(value);
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
