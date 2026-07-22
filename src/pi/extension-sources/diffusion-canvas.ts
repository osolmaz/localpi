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
// Loopback servers serve only this machine's user, so showing the single
// active request's canvas before its id is known cannot leak another
// person's text. See refreshLiveCanvas.
const allowUncorrelatedCanvas: boolean =
  eventsUrl !== null && /^https?:\\/\\/(127\\.0\\.0\\.1|localhost|\\[::1\\])(:|\\/)/u.test(eventsUrl);

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
  settledText: string;
  active: ActiveCell[];
  intervals: number[];
  liveMode: boolean;
  responseId: string | undefined;
  latestCanvasByRequest: Map<string, CanvasEvent>;
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
  readonly width: number;
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
  let countersAtTurnStart: Promise<DiffusionCounters | undefined> | undefined;
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
      state.latestCanvasByRequest.set(event.requestId, event);
      refreshLiveCanvas(state);
      requestRender();
    }).catch(() => {
      // Side channel unavailable (unpatched server or flag off): the widget
      // stays in the labeled simulated mode.
    });
  }

  // The side channel broadcasts every request on the server. Display the
  // canvas belonging to this turn's current completion: Pi's assistant
  // stream exposes the server request id as partial.responseId (the chatcmpl
  // id), which matches the SSE request_id. The diffusion server only sends
  // its first completion chunk when the first canvas commits, so the id is
  // unknown while the first canvas denoises. During that window, fall back
  // to the only active request, but exclusively on loopback servers: there
  // the subscriber and the requester are the same user, so no other client's
  // text can be exposed. On shared/remote servers, never render an
  // uncorrelated canvas.
  function refreshLiveCanvas(state: TurnState): void {
    let event: CanvasEvent | undefined;
    if (state.responseId !== undefined) {
      event = state.latestCanvasByRequest.get(state.responseId);
      if (event === undefined) {
        // No canvas yet for the current completion (e.g. a new completion
        // started after a tool call); drop any stale one.
        state.liveText = undefined;
        return;
      }
    } else if (allowUncorrelatedCanvas && state.latestCanvasByRequest.size === 1) {
      for (const only of state.latestCanvasByRequest.values()) {
        event = only;
      }
    }
    if (event === undefined) {
      return;
    }
    state.liveMode = true;
    state.liveText = event.text;
    state.liveStep = event.step;
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
      // Prometheus counters are server-wide, so this is an aggregate over
      // everything the server ran during the turn, not per-request.
      parts.push(\`\${stepsPerCanvas.toFixed(1)} steps/canvas (server)\`);
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
    // Component-factory widgets only render in the terminal UI; other modes
    // (RPC, print) must not start tickers, metrics polling, or the SSE feed.
    if (ctx.mode !== "tui") {
      return;
    }
    const state = newTurnState();
    current = state;
    stepsPerCanvas = undefined;
    countersAtTurnStart = fetchCounters();
    installWidget(ctx);
    startTicker();
    openEventStream();
  });

  pi.on("message_update", (event, ctx) => {
    const state = current;
    if (ctx.mode !== "tui" || state === undefined || state.done) {
      return;
    }
    // A turn can contain several completions (one per tool-call round), each
    // with its own server request id; always track the current one.
    const responseId = responseIdFromEvent(event.assistantMessageEvent);
    if (responseId !== undefined && responseId !== state.responseId) {
      state.responseId = responseId;
      refreshLiveCanvas(state);
    }
    const added = deltaFromEvent(event.assistantMessageEvent);
    if (added === undefined || added.text.length === 0) {
      return;
    }
    recordBurst(state, added.text, added.display);
    requestRender();
  });

  pi.on("turn_end", (_event, ctx) => {
    const state = current;
    if (ctx.mode !== "tui" || state === undefined) {
      return;
    }
    finishTurn(state);
    closeEventStream();
    // Wait for the turn-start sample: on short turns it can still be in
    // flight when the turn ends.
    const beforePromise = countersAtTurnStart;
    void Promise.all([beforePromise, fetchCounters()]).then(([before, after]) => {
      if (current !== state) {
        return;
      }
      if (before !== undefined && after !== undefined) {
        stepsPerCanvas = stepsPerCanvasFromDelta(before, after) ?? stepsPerCanvas;
      }
      requestRender();
    });
    requestRender();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopTicker();
    closeEventStream();
    current = undefined;
    if (widgetInstalled && ctx.hasUI) {
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
    settledText: "",
    active: [],
    intervals: [],
    liveMode: false,
    responseId: undefined,
    latestCanvasByRequest: new Map(),
    liveText: undefined,
    liveStep: 0,
    done: false
  };
}

function recordBurst(state: TurnState, added: string, display: boolean): void {
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
    if (display) {
      state.settledText += sanitize(added);
    }
    state.liveText = undefined;
    return;
  }
  state.settledText += state.active.map((cell) => cell.char).join("");
  if (!display) {
    // Tool-call commits pace the stats but their JSON is not settled into
    // the display text; Pi renders the tool call itself.
    state.active = [];
    return;
  }
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

// Approximate terminal display width: East Asian wide/fullwidth glyphs and
// emoji occupy two cells; combining marks occupy none. The real canvas mixes
// scripts freely, so rows must be packed by display width, not char count.
function charWidth(char: string): number {
  if (/^\\p{M}+$/u.test(char)) {
    return 0;
  }
  const cp = char.codePointAt(0) ?? 0;
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

function textWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += charWidth(char);
  }
  return width;
}

function cellsFromText(text: string, kind: RenderCellKind): RenderCell[] {
  return [...text].map((char) => ({ char, kind, width: charWidth(char) }));
}

function tailByWidth(text: string, maxWidth: number): string {
  const chars = [...text];
  let width = 0;
  let start = chars.length;
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const cw = charWidth(chars[index] ?? "");
    if (width + cw > maxWidth) {
      break;
    }
    width += cw;
    start = index;
  }
  return chars.slice(start).join("");
}

function headByWidth(text: string, maxWidth: number): string {
  const chars = [...text];
  let width = 0;
  let end = 0;
  for (const [index, char] of chars.entries()) {
    const cw = charWidth(char);
    if (width + cw > maxWidth) {
      break;
    }
    width += cw;
    end = index + 1;
  }
  return chars.slice(0, end).join("");
}

function canvasRows(state: TurnState, cols: number, theme: WidgetTheme): string[] {
  const cells = renderCells(state, cols * maxRows);
  const rows: string[] = [];
  let row: RenderCell[] = [];
  let rowWidth = 0;
  for (const cell of cells) {
    if (rowWidth + cell.width > cols) {
      rows.push(styleRow(row, theme));
      row = [];
      rowWidth = 0;
      if (rows.length >= maxRows) {
        return rows;
      }
    }
    row.push(cell);
    rowWidth += cell.width;
  }
  if (row.length > 0) {
    rows.push(styleRow(row, theme));
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
// Budgets are display-width cells.
function renderLiveCells(state: TurnState, budget: number): RenderCell[] {
  const canvas = state.liveText === undefined ? "" : sanitize(state.liveText);
  const settledReserve = Math.min(
    textWidth(state.settledText),
    Math.max(budget - textWidth(canvas), Math.ceil(budget / 4))
  );
  const canvasBudget = Math.max(budget - settledReserve, 0);
  return [
    ...cellsFromText(tailByWidth(state.settledText, settledReserve), "settled"),
    ...cellsFromText(headByWidth(canvas, canvasBudget), "noise")
  ];
}

// Simulated mode: while the turn runs, glyph noise fills all window space not
// yet holding text (the canvas still being denoised server-side), and commit
// bursts resolve from noise into the real text. Budgets are display-width
// cells; noise glyphs are all width 1.
function renderSimulatedCells(state: TurnState, budget: number): RenderCell[] {
  const now = Date.now();
  const settledWidth = textWidth(state.settledText);
  const activeWidth = state.active.reduce((width, cell) => width + charWidth(cell.char), 0);
  const aheadCount = state.done
    ? 0
    : Math.min(
        Math.max(budget - settledWidth - activeWidth, Math.ceil(budget / maxRows)),
        budget
      );
  const settledBudget = Math.max(budget - activeWidth - aheadCount, 0);
  const cells: RenderCell[] = [
    ...cellsFromText(tailByWidth(state.settledText, settledBudget), "settled")
  ];
  for (const cell of state.active) {
    cells.push(
      now >= cell.resolveAt
        ? { char: cell.char, kind: "resolved", width: charWidth(cell.char) }
        : { char: noiseChar(), kind: "noise", width: 1 }
    );
  }
  for (let index = 0; index < aheadCount; index += 1) {
    cells.push({ char: noiseChar(), kind: "ahead", width: 1 });
  }
  let total = cells.reduce((width, cell) => width + cell.width, 0);
  while (total > budget && cells.length > 0) {
    total -= cells[0]?.width ?? 0;
    cells.shift();
  }
  return cells;
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

type CommitDelta = {
  readonly text: string;
  // Whether the delta belongs in the settled display text. Tool-call JSON
  // paces the commit stats but is rendered by Pi's own tool widgets.
  readonly display: boolean;
};

// Pi's assistant stream events carry the in-progress message as "partial"
// (or the final one as "message"), whose responseId is the server-side
// request id (chatcmpl-...). That id is what the diffusion events side
// channel reports, so it correlates live canvas events with this turn.
function responseIdFromEvent(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const object = value as Record<string, unknown>;
  const partial = object["partial"] ?? object["message"];
  if (partial === null || typeof partial !== "object") {
    return undefined;
  }
  const responseId = (partial as Record<string, unknown>)["responseId"];
  return typeof responseId === "string" ? responseId : undefined;
}

// Every streamed delta is a canvas commit on a diffusion server, including
// thinking (DiffusionGemma routes its whole output through the reasoning
// field until an explicit end marker), so all delta kinds count toward the
// stats. Non-delta events (start/end/done markers) carry no new tokens.
function deltaFromEvent(value: unknown): CommitDelta | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const object = value as Record<string, unknown>;
  const type = object["type"];
  const delta = object["delta"];
  if (typeof type !== "string" || typeof delta !== "string") {
    return undefined;
  }
  if (type === "text_delta" || type === "thinking_delta") {
    return { text: delta, display: true };
  }
  if (type === "toolcall_delta") {
    return { text: delta, display: false };
  }
  return undefined;
}
`;
}
