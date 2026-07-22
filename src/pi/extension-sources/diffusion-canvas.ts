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
const metricsTimeoutMs = 5000;
const maxBufferedCanvases = 8;
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
      // The feed broadcasts every request on the server. Buffer per request
      // id (the correlated id can change mid-turn or arrive late on servers
      // that ignore the X-Request-Id header), but bound the buffer so a busy
      // shared server cannot grow it without limit: evict the oldest foreign
      // entry, never the correlated one.
      state.latestCanvasByRequest.delete(event.requestId);
      state.latestCanvasByRequest.set(event.requestId, event);
      if (state.latestCanvasByRequest.size > maxBufferedCanvases) {
        for (const requestId of state.latestCanvasByRequest.keys()) {
          if (requestId !== state.responseId) {
            state.latestCanvasByRequest.delete(requestId);
            break;
          }
        }
      }
      refreshLiveCanvas(state);
      requestRender();
    }).catch(() => {
      // Side channel unavailable (unpatched server or flag off): the widget
      // stays in the labeled simulated mode.
    });
  }

  // The side channel broadcasts every request on the server. Display only
  // the canvas belonging to this turn's current completion; an uncorrelated
  // canvas is never rendered, since on a shared server it could be another
  // client's text. The id is known before the first denoising step because
  // this extension assigns it via the X-Request-Id header (see the
  // before_provider_headers handler); Pi's assistant stream additionally
  // reports the server-authoritative id as partial.responseId with the first
  // committed chunk, which corrects the prediction on servers that ignore
  // the header.
  function refreshLiveCanvas(state: TurnState): void {
    if (state.responseId === undefined) {
      return;
    }
    const event = state.latestCanvasByRequest.get(state.responseId);
    if (event === undefined) {
      // No canvas yet for the current completion (e.g. a new completion
      // started after a tool call); drop any stale one.
      state.liveText = undefined;
      return;
    }
    if (!state.liveMode) {
      // If the event stream came up after commits already animated in
      // simulated mode, those committed chars still sit in the resolve
      // animation; settle them so the live renderer (which ignores the
      // animation cells) keeps the committed prefix visible.
      state.settledText += state.active.map((cell) => cell.char).join("");
      state.active = [];
      state.liveMode = true;
    }
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
    const rows = canvasRows(state, cols, theme);
    // Keep the widget height constant while active. The TUI renders
    // differentially and pushes the top viewport line into terminal
    // scrollback whenever the layout grows, so a widget that grows and
    // shrinks with the canvas text leaves a trail of stale frames in the
    // history. Rewriting a fixed set of rows in place leaves none.
    while (rows.length < maxRows) {
      rows.push("");
    }
    for (const row of rows) {
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

  // Assign each completion's request id up front: vLLM derives its request
  // id from the X-Request-Id header (chatcmpl-<header>), so setting the
  // header lets this turn correlate side-channel canvas events from the very
  // first denoising step, before the server streams any completion chunk.
  pi.on("before_provider_headers", (event) => {
    const state = current;
    if (state === undefined || state.done || eventsUrl === null) {
      return;
    }
    const requestTag = crypto.randomUUID().replace(/-/gu, "");
    event.headers["X-Request-Id"] = requestTag;
    state.responseId = \`chatcmpl-\${requestTag}\`;
    refreshLiveCanvas(state);
  });

  pi.on("message_update", (event, ctx) => {
    const state = current;
    if (ctx.mode !== "tui" || state === undefined || state.done) {
      return;
    }
    // A turn can contain several completions (one per tool-call round), each
    // with its own server request id. The id was predicted when the
    // X-Request-Id header was set; the stream's partial.responseId is the
    // server-authoritative value and corrects the prediction on servers that
    // ignore the header.
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

// The canvas mixes scripts freely mid-denoise (multilingual renoise tokens).
// Terminals disagree with any width model for combining marks, Indic
// conjuncts, emoji sequences, and bidi-reordered RTL runs; a single
// mispredicted cell hard-wraps a row and desyncs the TUI's differential
// renderer, leaving stale frames in the transcript. Render only glyphs with
// unambiguous monospace width and substitute the rest with a neutral dot:
// they read as noise either way, and the real text lands in the message.
const substituteGlyph = "\\u00b7";

function displayableChar(char: string): string {
  const cp = char.codePointAt(0) ?? 0;
  if (
    (cp >= 0x20 && cp <= 0x7e) ||
    (cp >= 0xa1 && cp <= 0x17f) ||
    (cp >= 0x370 && cp <= 0x3ff && cp !== 0x374 && cp !== 0x375) ||
    (cp >= 0x400 && cp <= 0x4ff) ||
    (cp >= 0x2010 && cp <= 0x2027) ||
    cp === 0x2591 ||
    isWideChar(cp)
  ) {
    return char;
  }
  return substituteGlyph;
}

function sanitize(text: string): string {
  const flattened = text.replace(/\\s+/gu, " ").replace(/\\p{C}/gu, "");
  let result = "";
  for (const char of flattened) {
    result += displayableChar(char);
  }
  return result;
}

// Unambiguously two-cell scripts in every monospace terminal: CJK
// punctuation and kana, CJK unified ideographs, Hangul syllables, CJK
// compatibility ideographs, and fullwidth forms.
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff01 && cp <= 0xff60)
  );
}

function charWidth(char: string): number {
  return isWideChar(char.codePointAt(0) ?? 0) ? 2 : 1;
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
    // SSE allows LF, CRLF, and CR line endings; normalize to LF so frame
    // splitting works for all conforming servers.
    buffer += decoder.decode(value, { stream: true }).replace(/\\r\\n?/gu, "\\n");
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
    // Bound the request so a stalled /metrics endpoint cannot accumulate
    // pending sockets across turns; a missed sample only hides the
    // steps/canvas stat.
    const response = await fetch(metricsUrl, { signal: AbortSignal.timeout(metricsTimeoutMs) });
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
