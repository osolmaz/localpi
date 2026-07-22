export type DiffusionCanvasUrls = {
  readonly metricsUrl?: string | undefined;
  readonly eventsUrl?: string | undefined;
};

export function diffusionCanvasExtensionSource(urls: DiffusionCanvasUrls | undefined): string {
  const metricsUrlSource = JSON.stringify(urls?.metricsUrl ?? null);
  const eventsUrlSource = JSON.stringify(urls?.eventsUrl ?? null);
  return `import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Diffusion LLM servers (e.g. DiffusionGemma on vLLM) denoise a whole canvas
// internally and only stream committed tokens when a canvas converges, so
// clients receive bursts separated by silent denoising intervals.
//
// Live mode (truthful): when the server exposes the /v1/diffusion/events SSE
// side channel (vLLM --diffusion-stream-canvas), this widget renders the real
// intermediate canvas per denoising step: accepted tokens mixed with the
// sampler's actual renoise tokens, converging to the committed text.
//
// Simulated mode (fallback, labeled): without the side channel, intermediate
// states never leave the engine, so the widget shows glyph noise during the
// real denoising silence and animates each commit burst. Burst boundaries,
// commit timing, and step counts are real; the glyphs are illustrative.
const metricsUrl: string | null = ${metricsUrlSource};
const eventsUrl: string | null = ${eventsUrlSource};

const widgetId = "localpi-diffusion-canvas";
const tickMs = 90;
const maxRows = 4;
const minResolveMs = 300;
const maxResolveMs = 1500;
const defaultResolveMs = 1200;
const noiseGlyphs = "abcdefghijklmnopqrstuvwxyz0123456789#%&@$+=~?";

type ActiveCell = {
  readonly char: string;
  readonly resolveAt: number;
};

type TurnState = {
  readonly startedAt: number;
  firstBurstAt: number | undefined;
  lastBurstAt: number | undefined;
  burstCount: number;
  totalChars: number;
  seenText: string;
  settledText: string;
  active: ActiveCell[];
  intervals: number[];
  liveMode: boolean;
  liveText: string | undefined;
  liveStep: number;
  done: boolean;
};

type DiffusionCounters = {
  readonly steps: number;
  readonly positions: number;
  readonly committed: number;
};

type RenderCellKind = "settled" | "resolved" | "noise" | "ahead";

type RenderCell = {
  readonly char: string;
  readonly kind: RenderCellKind;
};

type WidgetTheme = {
  fg(color: "accent" | "muted" | "dim" | "text", text: string): string;
};

type CanvasEvent = {
  readonly requestId: string;
  readonly step: number;
  readonly text: string;
};

export default function localpiDiffusionCanvas(pi: ExtensionAPI): void {
  let current: TurnState | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let requestRender = (): void => {};
  let widgetInstalled = false;
  let countersAtTurnStart: DiffusionCounters | undefined;
  let stepsPerCanvas: number | undefined;
  let eventsAbort: AbortController | undefined;

  function installWidget(ctx: ExtensionContext): void {
    if (widgetInstalled) {
      return;
    }
    widgetInstalled = true;
    ctx.ui.setWidget(widgetId, (tui, theme) => {
      requestRender = () => tui.requestRender();
      return {
        render: (width: number) => renderWidget(width, theme),
        invalidate: () => {}
      };
    });
  }

  function startTicker(): void {
    if (ticker === undefined) {
      ticker = setInterval(() => {
        requestRender();
        if (current !== undefined && current.done && animationDone(current)) {
          stopTicker();
        }
      }, tickMs);
    }
  }

  function stopTicker(): void {
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  }

  function openEventStream(): void {
    if (eventsUrl === null || eventsAbort !== undefined) {
      return;
    }
    const abort = new AbortController();
    eventsAbort = abort;
    void consumeEventStream(eventsUrl, abort.signal, (event) => {
      const state = current;
      if (state === undefined || state.done) {
        return;
      }
      // localpi drives a single local session; the latest event is ours.
      state.liveMode = true;
      state.liveText = event.text;
      state.liveStep = event.step;
      requestRender();
    }).catch(() => {
      // Side channel unavailable (unpatched server or flag off): the widget
      // stays in the labeled simulated mode.
    });
  }

  function closeEventStream(): void {
    eventsAbort?.abort();
    eventsAbort = undefined;
  }

  function renderWidget(width: number, theme: WidgetTheme): string[] {
    const state = current;
    if (state === undefined) {
      return [];
    }
    const cols = Math.max(16, width - 2);
    const lines = [" " + theme.fg("dim", truncate(headerText(state), cols))];
    // Once the turn is over and the last canvas has resolved, collapse to the
    // stats line: the full text is already visible in the message above.
    if (state.done && animationDone(state)) {
      return lines;
    }
    for (const row of canvasRows(state, cols, theme)) {
      lines.push(" " + row);
    }
    return lines;
  }

  function headerText(state: TurnState): string {
    const mode = state.liveMode ? "live" : "simulated";
    if (state.firstBurstAt === undefined) {
      if (state.done) {
        return "diffusion canvas | no output";
      }
      const waited = ((Date.now() - state.startedAt) / 1000).toFixed(1);
      if (state.liveMode) {
        return \`diffusion canvas | live | denoising canvas 1, step \${state.liveStep}... \${waited}s\`;
      }
      return \`diffusion canvas | simulated | denoising canvas 1 server-side... \${waited}s | text appears when the canvas commits\`;
    }
    const tokens = Math.ceil(state.totalChars / 4);
    const parts = [
      "diffusion canvas",
      mode,
      \`\${state.burstCount} commits\`,
      \`~\${Math.max(Math.round(tokens / state.burstCount), 1)} tok/commit\`
    ];
    const interval = medianOf(state.intervals);
    if (interval !== undefined) {
      parts.push(\`\${(interval / 1000).toFixed(1)}s/commit\`);
    }
    const elapsedSeconds = Math.max(
      ((state.lastBurstAt ?? state.startedAt) - state.startedAt) / 1000,
      0.001
    );
    parts.push(\`~\${(tokens / elapsedSeconds).toFixed(1)} tok/s\`);
    if (stepsPerCanvas !== undefined) {
      parts.push(\`\${stepsPerCanvas.toFixed(1)} steps/canvas\`);
    }
    if (state.done) {
      parts.push("done");
    } else if (state.liveMode) {
      parts.push(\`denoising canvas \${state.burstCount + 1}, step \${state.liveStep}...\`);
    } else {
      parts.push(\`denoising canvas \${state.burstCount + 1}...\`);
    }
    return parts.join(" | ");
  }

  pi.on("turn_start", (_event, ctx) => {
    if (!ctx.hasUI) {
      return;
    }
    current = newTurnState();
    stepsPerCanvas = undefined;
    countersAtTurnStart = undefined;
    installWidget(ctx);
    startTicker();
    openEventStream();
    void fetchCounters().then((counters) => {
      countersAtTurnStart = counters;
    });
  });

  pi.on("message_update", (event, ctx) => {
    const state = current;
    if (!ctx.hasUI || state === undefined || state.done) {
      return;
    }
    const update = textUpdateFromUnknown(event.assistantMessageEvent ?? event.message ?? event);
    const added = consumeAddedText(state, update);
    if (added.length === 0) {
      return;
    }
    recordBurst(state, added);
    requestRender();
  });

  pi.on("turn_end", (_event, ctx) => {
    const state = current;
    if (!ctx.hasUI || state === undefined) {
      return;
    }
    finishTurn(state);
    closeEventStream();
    const before = countersAtTurnStart;
    void fetchCounters().then((counters) => {
      if (before !== undefined && counters !== undefined) {
        stepsPerCanvas = stepsPerCanvasFromDelta(before, counters) ?? stepsPerCanvas;
      }
      requestRender();
    });
    requestRender();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopTicker();
    closeEventStream();
    current = undefined;
    if (ctx.hasUI) {
      ctx.ui.setWidget(widgetId, undefined);
    }
    widgetInstalled = false;
  });
}

function newTurnState(): TurnState {
  return {
    startedAt: Date.now(),
    firstBurstAt: undefined,
    lastBurstAt: undefined,
    burstCount: 0,
    totalChars: 0,
    seenText: "",
    settledText: "",
    active: [],
    intervals: [],
    liveMode: false,
    liveText: undefined,
    liveStep: 0,
    done: false
  };
}

function recordBurst(state: TurnState, added: string): void {
  const now = Date.now();
  if (state.firstBurstAt === undefined) {
    state.firstBurstAt = now;
  }
  if (state.lastBurstAt !== undefined) {
    state.intervals.push(now - state.lastBurstAt);
  }
  state.lastBurstAt = now;
  state.burstCount += 1;
  state.totalChars += added.length;
  if (state.liveMode) {
    // Truthful mode: the emergence was already shown live via the real
    // canvas states, so committed text settles immediately. Clear the live
    // canvas; the next denoising step brings the next block.
    state.settledText += sanitize(added);
    state.liveText = undefined;
    return;
  }
  state.settledText += state.active.map((cell) => cell.char).join("");
  const resolveMs = resolveDuration(state);
  const chars = [...sanitize(added)];
  state.active = chars.map((char) => ({
    char,
    resolveAt: now + Math.random() * resolveMs
  }));
}

// Keep the in-flight resolve animation on turn end; the last canvas would
// otherwise snap to text instantly because bursty servers deliver the final
// commit and the turn end back to back.
function finishTurn(state: TurnState): void {
  state.done = true;
  state.liveText = undefined;
}

function animationDone(state: TurnState): boolean {
  const now = Date.now();
  return state.active.every((cell) => now >= cell.resolveAt);
}

function resolveDuration(state: TurnState): number {
  const interval = medianOf(state.intervals);
  if (interval === undefined) {
    return defaultResolveMs;
  }
  return Math.min(Math.max(interval * 0.6, minResolveMs), maxResolveMs);
}

function medianOf(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function sanitize(text: string): string {
  return text.replace(/\\s+/gu, " ").replace(/\\p{C}/gu, "");
}

function canvasRows(state: TurnState, cols: number, theme: WidgetTheme): string[] {
  const cells = renderCells(state, cols * maxRows);
  const rows: string[] = [];
  for (let start = 0; start < cells.length; start += cols) {
    rows.push(styleRow(cells.slice(start, start + cols), theme));
  }
  return rows;
}

function renderCells(state: TurnState, budget: number): RenderCell[] {
  if (state.liveMode) {
    return renderLiveCells(state, budget);
  }
  return renderSimulatedCells(state, budget);
}

// Live mode: settled committed text followed by the real canvas snapshot of
// the block currently being denoised, exactly as reported by the server.
function renderLiveCells(state: TurnState, budget: number): RenderCell[] {
  const canvas = state.liveText === undefined ? "" : sanitize(state.liveText);
  const settledReserve = Math.min(
    state.settledText.length,
    Math.max(budget - canvas.length, Math.ceil(budget / 4))
  );
  const canvasBudget = Math.max(budget - settledReserve, 0);
  const cells: RenderCell[] = [];
  for (const char of state.settledText.slice(-settledReserve)) {
    cells.push({ char, kind: "settled" });
  }
  for (const char of canvas.slice(0, canvasBudget)) {
    cells.push({ char, kind: "noise" });
  }
  return cells;
}

// Simulated mode: while the turn runs, glyph noise fills all window space not
// yet holding text (the canvas still being denoised server-side), and commit
// bursts resolve from noise into the real text.
function renderSimulatedCells(state: TurnState, budget: number): RenderCell[] {
  const now = Date.now();
  const aheadCount = state.done
    ? 0
    : Math.min(
        Math.max(budget - state.settledText.length - state.active.length, Math.ceil(budget / maxRows)),
        budget
      );
  const settledBudget = Math.max(budget - state.active.length - aheadCount, 0);
  const cells: RenderCell[] = [];
  for (const char of state.settledText.slice(-settledBudget)) {
    cells.push({ char, kind: "settled" });
  }
  for (const cell of state.active) {
    cells.push(
      now >= cell.resolveAt
        ? { char: cell.char, kind: "resolved" }
        : { char: noiseChar(), kind: "noise" }
    );
  }
  for (let index = 0; index < aheadCount; index += 1) {
    cells.push({ char: noiseChar(), kind: "ahead" });
  }
  return cells.slice(-budget);
}

function styleRow(cells: readonly RenderCell[], theme: WidgetTheme): string {
  let row = "";
  let runKind: RenderCellKind | undefined;
  let runText = "";
  const flush = (): void => {
    if (runKind !== undefined && runText.length > 0) {
      row += styleRun(runKind, runText, theme);
    }
    runText = "";
  };
  for (const cell of cells) {
    if (cell.kind !== runKind) {
      flush();
      runKind = cell.kind;
    }
    runText += cell.char;
  }
  flush();
  return row;
}

function styleRun(kind: RenderCellKind, text: string, theme: WidgetTheme): string {
  switch (kind) {
    case "settled":
      return theme.fg("muted", text);
    case "resolved":
      return theme.fg("text", text);
    case "noise":
      return theme.fg("accent", text);
    case "ahead":
      return theme.fg("dim", text);
  }
}

function noiseChar(): string {
  return noiseGlyphs[Math.floor(Math.random() * noiseGlyphs.length)] ?? "?";
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : \`\${text.slice(0, Math.max(maxLength - 1, 0))}…\`;
}

async function consumeEventStream(
  url: string,
  signal: AbortSignal,
  onEvent: (event: CanvasEvent) => void
): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok || response.body === null) {
    throw new Error(\`diffusion events unavailable: \${String(response.status)}\`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const boundary = buffer.indexOf("\\n\\n");
      if (boundary === -1) {
        break;
      }
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseEventFrame(frame);
      if (event !== undefined) {
        onEvent(event);
      }
    }
  }
}

function parseEventFrame(frame: string): CanvasEvent | undefined {
  const dataLines = frame
    .split("\\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(dataLines.join("\\n"));
    if (parsed === null || typeof parsed !== "object") {
      return undefined;
    }
    const object = parsed as Record<string, unknown>;
    const requestId = object["request_id"];
    const step = object["step"];
    const text = object["text"];
    if (typeof requestId !== "string" || typeof step !== "number" || typeof text !== "string") {
      return undefined;
    }
    return { requestId, step, text };
  } catch {
    return undefined;
  }
}

async function fetchCounters(): Promise<DiffusionCounters | undefined> {
  if (metricsUrl === null) {
    return undefined;
  }
  try {
    const response = await fetch(metricsUrl);
    if (!response.ok) {
      return undefined;
    }
    return parseDiffusionCounters(await response.text());
  } catch {
    return undefined;
  }
}

function parseDiffusionCounters(body: string): DiffusionCounters | undefined {
  let steps: number | undefined;
  let positions: number | undefined;
  let committed: number | undefined;
  let found = false;
  for (const line of body.split("\\n")) {
    if (line.startsWith("#")) {
      continue;
    }
    const match = /^vllm:diffusion_(\\w+?)(?:_total)?(?:\\{[^}]*\\})? (\\S+)$/u.exec(line.trim());
    if (match === null) {
      continue;
    }
    const value = Number(match[2]);
    if (!Number.isFinite(value)) {
      continue;
    }
    if (match[1] === "num_denoising_steps") {
      steps = (steps ?? 0) + value;
      found = true;
    } else if (match[1] === "num_canvas_positions") {
      positions = (positions ?? 0) + value;
      found = true;
    } else if (match[1] === "num_committed_tokens") {
      committed = (committed ?? 0) + value;
      found = true;
    }
  }
  if (!found || steps === undefined || positions === undefined || committed === undefined) {
    return undefined;
  }
  return { steps, positions, committed };
}

function stepsPerCanvasFromDelta(
  before: DiffusionCounters,
  after: DiffusionCounters
): number | undefined {
  const steps = after.steps - before.steps;
  const positions = after.positions - before.positions;
  const committed = after.committed - before.committed;
  if (steps <= 0 || positions <= 0 || committed <= 0) {
    return undefined;
  }
  const canvasLength = positions / steps;
  const canvases = committed / canvasLength;
  const denoiseSteps = steps - canvases;
  if (canvases <= 0 || denoiseSteps <= 0) {
    return undefined;
  }
  return denoiseSteps / canvases;
}

type TextUpdate = {
  readonly kind: "delta" | "snapshot";
  readonly text: string;
};

function consumeAddedText(state: TurnState, update: TextUpdate): string {
  if (update.kind === "delta") {
    state.seenText += update.text;
    return update.text;
  }
  if (update.text.length <= state.seenText.length) {
    return "";
  }
  const added = update.text.slice(state.seenText.length);
  state.seenText = update.text;
  return added;
}

function textUpdateFromUnknown(value: unknown): TextUpdate {
  if (typeof value === "string") {
    return { kind: "snapshot", text: value };
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const delta = object["delta"];
    const text = object["text"] ?? object["content"];
    if (typeof delta === "string") {
      return { kind: "delta", text: delta };
    }
    if (typeof text === "string") {
      return { kind: "snapshot", text };
    }
  }
  return { kind: "snapshot", text: "" };
}
`;
}
