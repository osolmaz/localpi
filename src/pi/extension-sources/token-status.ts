import type { StatsMode } from "../../localpi/options.js";

export type TokenStatusConfig = {
  readonly settingsPath: string;
  readonly mode: StatsMode;
  readonly engine?: "llama-cpp";
  readonly baseUrl?: string;
  readonly modelId?: string;
};

export function tokenStatusExtensionSource(config: TokenStatusConfig): string {
  const settingsPathSource = JSON.stringify(config.settingsPath);
  const initialModeSource = JSON.stringify(config.mode);
  const slotsUrlSource = JSON.stringify(slotsUrl(config));
  return `import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type StatsMode = "off" | "line" | "full";

type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

type PrefillProgress = {
  processed: number;
  total: number;
};

type TurnState = {
  startedAt: number;
  firstOutputAt?: number;
  outputText: string;
  estimatedOutputTokens: number;
  prefill?: PrefillProgress;
  lastRenderAt: number;
};

type StatsEntry = {
  rate?: number;
  output?: number;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  prefillSeconds?: number;
  elapsedSeconds?: number;
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
};

type ContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

type ThemeLike = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

type Segment = {
  text: string;
  color: string;
};

type StatsContext = {
  readonly hasUI: boolean;
  readonly ui: {
    setWorkingMessage(message?: string): void;
    setStatus(key: string, text: string | undefined): void;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    theme: ThemeLike;
  };
  getContextUsage(): ContextUsage | undefined;
};

// Stats mode is remembered per localpi launch. /stats updates both this session and the setting.
const settingsPath = ${settingsPathSource};
const initialMode: StatsMode = ${initialModeSource};
// llama.cpp exposes live prefill progress on /slots. Other engines have no equivalent endpoint.
const slotsUrl: string | undefined = ${slotsUrlSource};

const entryType = "localpi-stats";
const modes: readonly StatsMode[] = ["off", "line", "full"];
const renderIntervalMs = 200;
const slotsIntervalMs = 300;
const slotsTimeoutMs = 1500;
const renderThrottleMs = 100;

export default function localpiTokenStatus(pi: ExtensionAPI): void {
  let mode: StatsMode = initialMode;
  let state: TurnState | undefined;
  let renderTimer: ReturnType<typeof setInterval> | undefined;
  let slotsTimer: ReturnType<typeof setInterval> | undefined;
  let slotsAvailable = slotsUrl !== undefined;

  pi.registerEntryRenderer(entryType, (entry, _options, theme) => {
    const data = readEntry(entry.data);
    return {
      render: (width: number) => [entryLine(data, theme, width)],
      invalidate: () => undefined
    };
  });

  pi.registerCommand("stats", {
    description: "Set localpi stats mode",
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trim().toLowerCase();
      const matches = modes.filter((value) => value.startsWith(trimmed));
      return matches.length === 0 ? null : matches.map((value) => ({ value, label: value }));
    },
    handler: async (args: string, ctx) => {
      const requested = parseMode(args);
      const next = requested === undefined ? await promptMode(mode, ctx) : requested;
      if (next === undefined) {
        return;
      }
      mode = next;
      await persistMode(next);
      if (ctx.hasUI) {
        ctx.ui.setWorkingMessage();
        if (next === "off") {
          ctx.ui.setStatus(entryType, undefined);
        }
      }
      ctx.ui.notify("stats: " + next, "info");
    }
  });

  pi.on("turn_start", (_event, ctx) => {
    stopTimers();
    state = { startedAt: Date.now(), outputText: "", estimatedOutputTokens: 0, lastRenderAt: 0 };
    if (!ctx.hasUI || mode === "off") {
      return;
    }
    render(ctx, Date.now());
    renderTimer = setInterval(() => {
      render(ctx, Date.now());
    }, renderIntervalMs);
    if (mode === "full" && slotsAvailable) {
      slotsTimer = setInterval(() => {
        void pollPrefill();
      }, slotsIntervalMs);
    }
  });

  pi.on("message_update", (event, ctx) => {
    const current = state;
    if (current === undefined) {
      return;
    }
    const delta = textDelta(event.assistantMessageEvent);
    if (delta === undefined) {
      const snapshot = messageText(event.message);
      if (snapshot.length > current.outputText.length) {
        current.outputText = snapshot;
      }
    } else {
      current.outputText += delta;
    }
    current.estimatedOutputTokens = Math.ceil(current.outputText.length / 4);
    if (current.firstOutputAt === undefined && current.outputText.length > 0) {
      current.firstOutputAt = Date.now();
      stopSlotsTimer();
    }
    render(ctx, Date.now());
  });

  pi.on("turn_end", (event, ctx) => {
    const current = state ?? emptyState();
    state = undefined;
    stopTimers();
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.setWorkingMessage();
    if (event.message.role !== "assistant") {
      return;
    }
    const data = turnEntry(current, usageOf(event.message), contextUsage(ctx), Date.now());
    if (mode !== "full") {
      return;
    }
    pi.appendEntry(entryType, data);
    ctx.ui.setStatus(entryType, footerLine(data, ctx.ui.theme));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopTimers();
    state = undefined;
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.setStatus(entryType, undefined);
    ctx.ui.setWorkingMessage();
  });

  function stopTimers(): void {
    stopRenderTimer();
    stopSlotsTimer();
  }

  function stopRenderTimer(): void {
    if (renderTimer === undefined) {
      return;
    }
    clearInterval(renderTimer);
    renderTimer = undefined;
  }

  function stopSlotsTimer(): void {
    if (slotsTimer === undefined) {
      return;
    }
    clearInterval(slotsTimer);
    slotsTimer = undefined;
  }

  function render(ctx: StatsContext, now: number): void {
    const current = state;
    if (current === undefined || !ctx.hasUI || mode === "off") {
      return;
    }
    if (now - current.lastRenderAt < renderThrottleMs) {
      return;
    }
    current.lastRenderAt = now;
    ctx.ui.setWorkingMessage(workingLine(current, now, contextUsage(ctx), ctx.ui.theme));
  }

  async function pollPrefill(): Promise<void> {
    const current = state;
    if (current === undefined || slotsUrl === undefined || !slotsAvailable) {
      return;
    }
    if (current.firstOutputAt !== undefined) {
      stopSlotsTimer();
      return;
    }
    try {
      const response = await fetch(slotsUrl, { signal: AbortSignal.timeout(slotsTimeoutMs) });
      if (!response.ok) {
        throw new Error("llama.cpp slots request failed");
      }
      const progress = prefillProgress(await response.json());
      if (progress !== undefined) {
        current.prefill = progress;
      }
    } catch {
      // The endpoint is missing or slow. Fall back to elapsed-time prefill display for this session.
      slotsAvailable = false;
      stopSlotsTimer();
    }
  }
}

function emptyState(): TurnState {
  return { startedAt: Date.now(), outputText: "", estimatedOutputTokens: 0, lastRenderAt: 0 };
}

function workingLine(
  state: TurnState,
  now: number,
  usage: ContextUsage | undefined,
  theme: ThemeLike
): string {
  return (
    theme.bold("Working") +
    theme.fg("dim", " (") +
    renderParts(workingParts(state, now, usage), theme) +
    theme.fg("dim", ")")
  );
}

function workingParts(state: TurnState, now: number, usage: ContextUsage | undefined): Segment[][] {
  const parts: Segment[][] = [];
  if (state.firstOutputAt === undefined) {
    parts.push(...prefillParts(state, now));
  } else {
    const seconds = secondsBetween(state.firstOutputAt, now);
    parts.push([{ text: formatElapsed(seconds), color: "dim" }]);
    parts.push([
      { text: formatTokenCount(state.estimatedOutputTokens) + " out", color: "dim" }
    ]);
    parts.push([
      { text: formatRate(state.estimatedOutputTokens / seconds) + " tok/s", color: "accent" }
    ]);
  }
  parts.push(...contextParts(usage, false));
  return parts;
}

function prefillParts(state: TurnState, now: number): Segment[][] {
  const seconds = secondsBetween(state.startedAt, now);
  const progress = state.prefill;
  if (progress === undefined || progress.total <= 0) {
    return [[{ text: "prefill " + formatElapsed(seconds), color: "dim" }]];
  }
  const percent = Math.min(100, Math.max(0, Math.round((progress.processed / progress.total) * 100)));
  return [
    [
      { text: "prefill ", color: "dim" },
      { text: percent + "%", color: "accent" }
    ],
    [
      {
        text: formatTokenCount(progress.processed) + "/" + formatTokenCount(progress.total) + " tok",
        color: "dim"
      }
    ],
    [{ text: formatElapsed(seconds), color: "dim" }]
  ];
}

function entryLine(data: StatsEntry, theme: ThemeLike, width: number): string {
  const parts = entryParts(data);
  const plain = parts.map((part) => part.map((segment) => segment.text).join("")).join(" · ");
  if (width > 0 && plain.length > width) {
    return theme.fg("dim", plain.slice(0, Math.max(0, width - 1)) + "…");
  }
  return renderParts(parts, theme);
}

function entryParts(data: StatsEntry): Segment[][] {
  const parts: Segment[][] = [];
  if (data.elapsedSeconds !== undefined) {
    parts.push([{ text: formatElapsed(data.elapsedSeconds), color: "dim" }]);
  }
  if (data.output !== undefined) {
    parts.push([{ text: formatTokenCount(data.output) + " out", color: "dim" }]);
  }
  if (data.rate !== undefined) {
    parts.push([{ text: formatRate(data.rate) + " tok/s", color: "accent" }]);
  }
  if (data.input !== undefined && data.input > 0) {
    parts.push([{ text: formatTokenCount(data.input) + " in", color: "dim" }]);
  }
  if (data.cacheRead !== undefined && data.cacheRead > 0) {
    parts.push([{ text: "cache " + formatTokenCount(data.cacheRead), color: "dim" }]);
  }
  if (data.cacheWrite !== undefined && data.cacheWrite > 0) {
    parts.push([{ text: "cache write " + formatTokenCount(data.cacheWrite), color: "dim" }]);
  }
  if (data.prefillSeconds !== undefined) {
    parts.push([{ text: "prefill " + formatElapsed(data.prefillSeconds), color: "dim" }]);
  }
  parts.push(...contextParts(entryContext(data), true));
  return parts;
}

function footerLine(data: StatsEntry, theme: ThemeLike): string {
  const parts: Segment[][] = [];
  if (data.rate !== undefined) {
    parts.push([{ text: formatRate(data.rate) + " tok/s", color: "accent" }]);
  }
  parts.push(...contextParts(entryContext(data), false));
  return parts.length === 0 ? "" : renderParts(parts, theme);
}

function entryContext(data: StatsEntry): ContextUsage | undefined {
  if (data.contextPercent === undefined) {
    return undefined;
  }
  return {
    tokens: data.contextTokens ?? null,
    contextWindow: data.contextWindow ?? 0,
    percent: data.contextPercent
  };
}

function contextParts(usage: ContextUsage | undefined, detailed: boolean): Segment[][] {
  if (usage === undefined || usage.percent === null) {
    return [];
  }
  const color = contextColor(usage.percent);
  if (detailed && usage.tokens !== null && usage.contextWindow > 0) {
    return [
      [
        { text: "ctx ", color: "dim" },
        {
          text:
            formatTokenCount(usage.tokens) +
            "/" +
            formatTokenCount(usage.contextWindow) +
            " (" +
            Math.round(usage.percent) +
            "%)",
          color
        }
      ]
    ];
  }
  return [
    [
      { text: "ctx ", color: "dim" },
      { text: Math.round(usage.percent) + "%", color }
    ]
  ];
}

function contextColor(percent: number): string {
  if (percent >= 95) {
    return "error";
  }
  return percent >= 80 ? "warning" : "accent";
}

function renderParts(parts: readonly Segment[][], theme: ThemeLike): string {
  return parts
    .map((part) => part.map((segment) => theme.fg(segment.color, segment.text)).join(""))
    .join(theme.fg("dim", " · "));
}

function turnEntry(
  state: TurnState,
  usage: Usage | undefined,
  context: ContextUsage | undefined,
  now: number
): StatsEntry {
  const firstOutputAt = state.firstOutputAt;
  const output = usage?.output ?? state.estimatedOutputTokens;
  return withoutUndefined({
    rate: firstOutputAt === undefined ? undefined : output / secondsBetween(firstOutputAt, now),
    output,
    input: usage?.input,
    cacheRead: usage?.cacheRead,
    cacheWrite: usage?.cacheWrite,
    prefillSeconds:
      firstOutputAt === undefined ? undefined : secondsBetween(state.startedAt, firstOutputAt),
    elapsedSeconds: secondsBetween(state.startedAt, now),
    contextTokens: context?.tokens ?? undefined,
    contextWindow: context?.contextWindow,
    contextPercent: context?.percent ?? undefined
  });
}

function contextUsage(ctx: StatsContext): ContextUsage | undefined {
  return ctx.getContextUsage();
}

function readEntry(data: unknown): StatsEntry {
  if (!isRecord(data)) {
    return {};
  }
  return withoutUndefined({
    rate: numberOrUndefined(data["rate"]),
    output: numberOrUndefined(data["output"]),
    input: numberOrUndefined(data["input"]),
    cacheRead: numberOrUndefined(data["cacheRead"]),
    cacheWrite: numberOrUndefined(data["cacheWrite"]),
    prefillSeconds: numberOrUndefined(data["prefillSeconds"]),
    elapsedSeconds: numberOrUndefined(data["elapsedSeconds"]),
    contextTokens: numberOrUndefined(data["contextTokens"]),
    contextWindow: numberOrUndefined(data["contextWindow"]),
    contextPercent: numberOrUndefined(data["contextPercent"])
  });
}

function usageOf(message: unknown): Usage | undefined {
  if (!isRecord(message) || !isRecord(message["usage"])) {
    return undefined;
  }
  const usage = message["usage"] as Record<string, unknown>;
  return {
    input: numberOrUndefined(usage["input"]),
    output: numberOrUndefined(usage["output"]),
    cacheRead: numberOrUndefined(usage["cacheRead"]),
    cacheWrite: numberOrUndefined(usage["cacheWrite"])
  };
}

function textDelta(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const type = value["type"];
  if (type !== "text_delta" && type !== "thinking_delta" && type !== "toolcall_delta") {
    return undefined;
  }
  return typeof value["delta"] === "string" ? value["delta"] : undefined;
}

function messageText(message: unknown): string {
  if (!isRecord(message)) {
    return "";
  }
  const content = message["content"];
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : ""))
    .join("");
}

function prefillProgress(slots: unknown): PrefillProgress | undefined {
  if (!Array.isArray(slots)) {
    return undefined;
  }
  let best: PrefillProgress | undefined;
  for (const slot of slots) {
    if (!isRecord(slot) || slot["is_processing"] !== true) {
      continue;
    }
    const total = numberOrUndefined(slot["n_prompt_tokens"]);
    if (total === undefined || total <= 0) {
      continue;
    }
    const candidate = { total, processed: numberOrUndefined(slot["n_prompt_tokens_processed"]) ?? 0 };
    if (best === undefined || candidate.total > best.total) {
      best = candidate;
    }
  }
  return best;
}

function parseMode(value: string): StatsMode | undefined {
  const normalized = value.trim().split(/\\s+/u)[0]?.toLowerCase();
  return modes.find((mode) => mode === normalized);
}

async function promptMode(current: StatsMode, ctx: StatsContext): Promise<StatsMode | undefined> {
  const selectable = ctx as StatsContext & {
    ui: { select(title: string, options: string[]): Promise<string | undefined> };
  };
  const selected = await selectable.ui.select(
    "Stats mode",
    modes.map((mode) => (mode === current ? mode + " (current)" : mode))
  );
  return selected === undefined ? undefined : parseMode(selected);
}

async function persistMode(mode: StatsMode): Promise<void> {
  const settings = await readSettings();
  settings["stats"] = mode;
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

async function readSettings(): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    return isRecord(value) ? { ...value } : {};
  } catch {
    return {};
  }
}

function formatElapsed(seconds: number): string {
  const value = Math.max(0, seconds);
  if (value < 10) {
    return value.toFixed(1) + "s";
  }
  const total = Math.floor(value);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes > 0 ? minutes + "m" + String(rest).padStart(2, "0") + "s" : total + "s";
}

function formatRate(rate: number | undefined): string {
  if (rate === undefined || !Number.isFinite(rate)) {
    return "—";
  }
  const oneDecimal = Number(rate.toFixed(1));
  return oneDecimal < 100 ? oneDecimal.toFixed(1) : String(Math.round(oneDecimal));
}

function formatTokenCount(tokens: number): string {
  const value = Math.max(0, tokens);
  if (value < 1000) {
    return String(Math.round(value));
  }
  if (value < 1000000) {
    return compact(value / 1000, "k");
  }
  return compact(value / 1000000, "M");
}

function compact(value: number, suffix: string): string {
  const decimals = value < 10 ? 1 : 0;
  return value.toFixed(decimals).replace(/\\.0$/u, "") + suffix;
}

function secondsBetween(start: number, end: number): number {
  return Math.max((end - start) / 1000, 0.001);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return Object.fromEntries(entries) as Partial<T>;
}
`;
}

function slotsUrl(config: TokenStatusConfig): string | undefined {
  if (config.engine !== "llama-cpp" || config.baseUrl === undefined) {
    return undefined;
  }
  const root = config.baseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
  const model = config.modelId === undefined ? "" : `?model=${encodeURIComponent(config.modelId)}`;
  return `${root}/slots${model}`;
}
