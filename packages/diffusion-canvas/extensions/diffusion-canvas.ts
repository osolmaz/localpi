import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
//
// Server URLs resolve at turn start: the PI_DIFFUSION_CANVAS_EVENTS_URL and
// PI_DIFFUSION_CANVAS_METRICS_URL environment variables win, otherwise both
// derive from the active model's baseUrl (an OpenAI-compatible ".../v1").
let metricsUrl: string | null = null;
let eventsUrl: string | null = null;

function resolveServerUrls(ctx: ExtensionContext): void {
  const baseUrl = ctx.model?.baseUrl;
  metricsUrl =
    process.env["PI_DIFFUSION_CANVAS_METRICS_URL"] ?? serverUrlFromBase(baseUrl, "/metrics");
  eventsUrl =
    process.env["PI_DIFFUSION_CANVAS_EVENTS_URL"] ??
    serverUrlFromBase(baseUrl, "/v1/diffusion/events");
}

function serverUrlFromBase(baseUrl: string | undefined, path: string): string | null {
  if (baseUrl === undefined || baseUrl.length === 0) {
    return null;
  }
  const origin = baseUrl.replace(/\/v1\/?$/u, "").replace(/\/$/u, "");
  return origin.length === 0 ? null : origin + path;
}

const widgetId = "pi-diffusion-canvas";
const tickMs = 90;
const maxRows = 4;
// Live mode shows the entire canvas being denoised (a ~256-token block can
// take ~10 rows), so its cap is much larger than the simulated window.
const liveMaxRows = 16;
const minResolveMs = 300;
const maxResolveMs = 1500;
const defaultResolveMs = 1200;
const metricsTimeoutMs = 5000;
const maxBufferedCanvases = 8;
// After a commit, canvas events of the committed block can still be in
// flight on the SSE connection (it races the completion stream on a separate
// socket); rendering one would duplicate the settled text. Events carrying a
// block ordinal are filtered exactly; without one, drop events for a short
// grace window after each commit.
const commitGraceMs = 250;
// The server never streams the converged canvas (commit steps emit no
// event), so the widget renders it itself: the committed text stays bright
// for a moment before muting into the settled document.
const flashMs = 450;
// Rows of settled context kept above the seam (where settled text meets the
// canvas) in the live window.
const liveSettledContextRows = 2;
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
  rowsHighWater: number;
  responseId: string | undefined;
  latestCanvasByRequest: Map<string, CanvasEvent>;
  liveText: string | undefined;
  liveStep: number;
  liveBlock: number | undefined;
  // Staleness floors, set at each commit: canvas events at or below them
  // belong to an already-committed block. Steps and block ordinals are
  // per-request, so both reset when the completion's request id changes.
  stepFloor: number;
  blockFloor: number | undefined;
  suppressCanvasUntil: number;
  // The most recent commit renders bright until flashUntil (the converged
  // canvas frame the server never streams).
  flashUntil: number;
  flashChars: number;
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
  // Commit ordinal of the block this snapshot belongs to. Newer servers
  // include it; when present it identifies stale snapshots exactly.
  readonly block: number | undefined;
};

export default function localpiDiffusionCanvas(pi: ExtensionAPI): void {
  let current: TurnState | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let requestRender = (): void => undefined;
  let widgetInstalled = false;
  let countersAtTurnStart: Promise<DiffusionCounters | undefined> | undefined;
  let stepsPerCanvas: number | undefined;
  let eventsAbort: AbortController | undefined;
  let subscribedRequestId: string | undefined;

  function installWidget(ctx: ExtensionContext): void {
    if (widgetInstalled) {
      return;
    }
    widgetInstalled = true;
    ctx.ui.setWidget(widgetId, (tui, theme) => {
      requestRender = () => {
        tui.requestRender();
      };
      return {
        render: (width: number) => renderWidget(width, theme),
        invalidate: () => undefined
      };
    });
  }

  function startTicker(): void {
    ticker ??= setInterval(() => {
      requestRender();
      if (current !== undefined && current.done && animationDone(current)) {
        stopTicker();
      }
    }, tickMs);
  }

  function stopTicker(): void {
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  }

  // Subscribe scoped to one request id: the server then never sends other
  // clients' canvas states to this process. The subscription is (re)opened
  // whenever the current completion's id becomes known, so nothing is
  // subscribed while no id is held.
  function openEventStream(requestId: string): void {
    if (eventsUrl === null) {
      return;
    }
    if (subscribedRequestId === requestId && eventsAbort !== undefined) {
      return;
    }
    closeEventStream();
    subscribedRequestId = requestId;
    const abort = new AbortController();
    eventsAbort = abort;
    const separator = eventsUrl.includes("?") ? "&" : "?";
    const url = `${eventsUrl}${separator}request_id=${encodeURIComponent(requestId)}`;
    void consumeEventStream(url, abort.signal, (event) => {
      const state = current;
      if (state === undefined || state.done) {
        return;
      }
      // A server that predates the request_id query parameter ignores it and
      // broadcasts every request, so filtering here stays as defense. Buffer
      // per request id (the correlated id can change mid-turn or arrive late
      // on servers that ignore the X-Request-Id header), but bound the buffer
      // so a busy shared server cannot grow it without limit: evict the
      // oldest foreign entry, never the correlated one.
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

  // The SSE subscription is scoped server-side to this turn's request id;
  // this filter is defense in depth for servers that predate the request_id
  // query parameter and still broadcast every request. Display only the
  // canvas belonging to this turn's current completion; an uncorrelated
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
    if (isStaleCanvas(state, event)) {
      // A snapshot of an already-committed block that raced the commit
      // chunk; rendering it would duplicate the settled text.
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
    state.liveBlock = event.block;
  }

  function closeEventStream(): void {
    eventsAbort?.abort();
    eventsAbort = undefined;
    subscribedRequestId = undefined;
  }

  // The canvas rows come first and the stats line sits below them, so the
  // document flows straight from Pi's streamed message into the resolving
  // canvas with nothing in between.
  function renderWidget(width: number, theme: WidgetTheme): string[] {
    const state = current;
    if (state === undefined) {
      return [];
    }
    const cols = Math.max(16, width - 2);
    const statsLine = " " + theme.fg("dim", truncate(headerText(state), cols));
    // Once the turn is over and the last canvas has resolved, collapse to the
    // stats line: the full text is already visible in the message above.
    if (state.done && animationDone(state)) {
      return [statsLine];
    }
    const rows = canvasRows(state, cols, theme);
    // Keep the widget height stable while active: pad to the tallest layout
    // seen this turn (it only ratchets up when a bigger canvas arrives). The
    // TUI renders differentially, so a widget that grew and shrank with the
    // canvas text every frame would leave a trail of stale frames in the
    // terminal scrollback; rewriting a fixed set of rows in place leaves
    // none.
    state.rowsHighWater = Math.max(state.rowsHighWater, rows.length);
    while (rows.length < state.rowsHighWater) {
      rows.push("");
    }
    return [...rows.map((row) => " " + row), statsLine];
  }

  function headerText(state: TurnState): string {
    const mode = state.liveMode ? "live" : "simulated";
    // The server's step counter is monotonic per request; subtracting the
    // floor recorded at the last commit yields the step within the canvas
    // currently being denoised.
    const canvasStep = Math.max(state.liveStep - state.stepFloor, 0);
    if (state.firstBurstAt === undefined) {
      if (state.done) {
        return "diffusion canvas | no output";
      }
      const waited = ((Date.now() - state.startedAt) / 1000).toFixed(1);
      if (state.liveMode) {
        return `diffusion canvas | live | denoising canvas 1, step ${String(canvasStep)}... ${waited}s`;
      }
      return `diffusion canvas | simulated | denoising canvas 1 server-side... ${waited}s | text appears when the canvas commits`;
    }
    const tokens = Math.ceil(state.totalChars / 4);
    const parts = [
      "diffusion canvas",
      mode,
      `${String(state.burstCount)} commits`,
      `~${String(Math.max(Math.round(tokens / state.burstCount), 1))} tok/commit`
    ];
    const interval = medianOf(state.intervals);
    if (interval !== undefined) {
      parts.push(`${(interval / 1000).toFixed(1)}s/commit`);
    }
    const elapsedSeconds = Math.max(
      ((state.lastBurstAt ?? state.startedAt) - state.startedAt) / 1000,
      0.001
    );
    parts.push(`~${(tokens / elapsedSeconds).toFixed(1)} tok/s`);
    if (stepsPerCanvas !== undefined) {
      // Prometheus counters are server-wide, so this is an aggregate over
      // everything the server ran during the turn, not per-request.
      parts.push(`${stepsPerCanvas.toFixed(1)} steps/canvas (server)`);
    }
    if (state.done) {
      parts.push("done");
    } else if (state.liveMode) {
      parts.push(
        `denoising canvas ${String(state.burstCount + 1)}, step ${String(canvasStep)}...`
      );
    } else {
      parts.push(`denoising canvas ${String(state.burstCount + 1)}...`);
    }
    return parts.join(" | ");
  }

  pi.on("turn_start", (_event, ctx) => {
    // Component-factory widgets only render in the terminal UI; other modes
    // (RPC, print) must not start tickers, metrics polling, or the SSE feed.
    if (ctx.mode !== "tui") {
      return;
    }
    resolveServerUrls(ctx);
    const state = newTurnState();
    current = state;
    stepsPerCanvas = undefined;
    countersAtTurnStart = fetchCounters();
    installWidget(ctx);
    // The widget header already shows live turn status (canvas, step,
    // elapsed), so Pi's built-in working spinner row is redundant noise
    // directly above it.
    ctx.ui.setWorkingVisible(false);
    startTicker();
    // The SSE subscription opens once the completion's request id is known
    // (header hook or first stream chunk); it is always scoped to that id.
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
    state.responseId = `chatcmpl-${requestTag}`;
    resetLiveCorrelation(state);
    openEventStream(state.responseId);
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
      resetLiveCorrelation(state);
      openEventStream(responseId);
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
      ctx.ui.setWorkingVisible(true);
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
    rowsHighWater: maxRows,
    responseId: undefined,
    latestCanvasByRequest: new Map(),
    liveText: undefined,
    liveStep: 0,
    liveBlock: undefined,
    stepFloor: 0,
    blockFloor: undefined,
    suppressCanvasUntil: 0,
    flashUntil: 0,
    flashChars: 0,
    done: false
  };
}

// A commit ends its block, but the block's canvas events can still be in
// flight (the SSE feed and the completion stream are separate connections);
// rendering one after the commit shows the committed text twice. The block
// ordinal identifies such snapshots exactly. Servers without it fall back to
// the per-request step counter (a replayed step is always stale) plus a
// short post-commit grace window absorbing cross-connection reordering.
function isStaleCanvas(state: TurnState, event: CanvasEvent): boolean {
  if (event.block !== undefined) {
    return state.blockFloor !== undefined && event.block <= state.blockFloor;
  }
  if (event.step <= state.stepFloor) {
    return true;
  }
  return Date.now() < state.suppressCanvasUntil;
}

// A new completion is a new server request whose step counter and block
// ordinals restart from zero; the previous completion's staleness floors
// must not swallow its first canvas events.
function resetLiveCorrelation(state: TurnState): void {
  state.liveStep = 0;
  state.liveBlock = undefined;
  state.stepFloor = 0;
  state.blockFloor = undefined;
  state.suppressCanvasUntil = 0;
}

function recordBurst(state: TurnState, added: string, display: boolean): void {
  const now = Date.now();
  state.firstBurstAt ??= now;
  if (state.lastBurstAt !== undefined) {
    state.intervals.push(now - state.lastBurstAt);
  }
  state.lastBurstAt = now;
  state.burstCount += 1;
  state.totalChars += added.length;
  // This commit ends the block being denoised: raise the staleness floors so
  // the block's in-flight canvas events cannot re-render after the settled
  // text (see isStaleCanvas).
  state.stepFloor = state.liveStep;
  state.blockFloor = state.liveBlock;
  state.suppressCanvasUntil = now + commitGraceMs;
  if (state.liveMode) {
    // Truthful mode: the emergence was already shown live via the real
    // canvas states. The committed text is the converged canvas the server
    // never streams (commit steps emit no event), so render it bright for a
    // moment before it mutes into the settled document. The next denoising
    // step brings the next block.
    if (display) {
      const settled = sanitize(added);
      state.settledText += settled;
      state.flashChars = [...settled].length;
      state.flashUntil = now + flashMs;
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
  return now >= state.flashUntil && state.active.every((cell) => now >= cell.resolveAt);
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
const substituteGlyph = "\u00b7";

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
  const flattened = text.replace(/\s+/gu, " ").replace(/\p{C}/gu, "");
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

function canvasRows(state: TurnState, cols: number, theme: WidgetTheme): string[] {
  const rowCap = state.liveMode ? liveMaxRows : maxRows;
  const cells = renderCells(state, cols * rowCap);
  const rows: RenderCell[][] = [];
  let row: RenderCell[] = [];
  let rowWidth = 0;
  let seamRow = 0;
  for (const cell of cells) {
    if (rowWidth + cell.width > cols) {
      rows.push(row);
      row = [];
      rowWidth = 0;
    }
    row.push(cell);
    rowWidth += cell.width;
    if (cell.kind === "settled" || cell.kind === "resolved") {
      seamRow = rows.length;
    }
  }
  if (row.length > 0) {
    rows.push(row);
  }
  // Live mode packs the whole settled+canvas document from its start, so row
  // boundaries of already-committed text never move. The window anchors to
  // the seam (the row where the settled text ends): a fixed amount of
  // settled context stays above it and the canvas fills the rest. The
  // canvas's decoded width fluctuates on every denoising step, so an
  // end-anchored window would shift all visible rows each step; anchored to
  // the seam, the committed text holds still and the view scrolls only when
  // a commit moves the seam (like a terminal). Simulated mode builds a
  // budget-sized window, so its rows are the head.
  const windowStart = state.liveMode ? Math.max(0, seamRow - liveSettledContextRows) : 0;
  const visible = rows.slice(windowStart, windowStart + rowCap);
  return visible.map((cellsRow) => styleRow(cellsRow, theme));
}

function renderCells(state: TurnState, budget: number): RenderCell[] {
  if (state.liveMode) {
    return renderLiveCells(state);
  }
  return renderSimulatedCells(state, budget);
}

// Live mode: one continuous document, the committed text concatenated with
// the canvas snapshot currently being denoised. It is never clipped here;
// canvasRows packs it from the start (stable row boundaries for committed
// text) and anchors its window to the seam, so on a commit the resolved text
// stays in place and the next canvas continues mid-row without a gap. The
// freshest commit renders bright until its flash expires.
function renderLiveCells(state: TurnState): RenderCell[] {
  const canvas = state.liveText === undefined ? "" : sanitize(state.liveText);
  const settled = [...state.settledText];
  const flashCount =
    Date.now() < state.flashUntil ? Math.min(state.flashChars, settled.length) : 0;
  const stable = settled.slice(0, settled.length - flashCount).join("");
  const flashing = settled.slice(settled.length - flashCount).join("");
  return [
    ...cellsFromText(stable, "settled"),
    ...cellsFromText(flashing, "resolved"),
    ...cellsFromText(canvas, "noise")
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
    : Math.min(Math.max(budget - settledWidth - activeWidth, Math.ceil(budget / maxRows)), budget);
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
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(maxLength - 1, 0))}…`;
}

async function consumeEventStream(
  url: string,
  signal: AbortSignal,
  onEvent: (event: CanvasEvent) => void
): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok || response.body === null) {
    throw new Error(`diffusion events unavailable: ${String(response.status)}`);
  }
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  // fetch rejects reads on abort, but cancel explicitly so the stream is
  // released even when a runtime (or test double) ignores the signal.
  signal.addEventListener("abort", () => void reader.cancel().catch(() => undefined), {
    once: true
  });
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done || signal.aborted) {
      return;
    }
    // SSE allows LF, CRLF, and CR line endings; normalize to LF so frame
    // splitting works for all conforming servers.
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/gu, "\n");
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
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
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(dataLines.join("\n"));
    if (parsed === null || typeof parsed !== "object") {
      return undefined;
    }
    const object = parsed as Record<string, unknown>;
    const requestId = object["request_id"];
    const step = object["step"];
    const text = object["text"];
    const block = object["block"];
    if (typeof requestId !== "string" || typeof step !== "number" || typeof text !== "string") {
      return undefined;
    }
    return { requestId, step, text, block: typeof block === "number" ? block : undefined };
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
  for (const line of body.split("\n")) {
    if (line.startsWith("#")) {
      continue;
    }
    const match = /^vllm:diffusion_(\w+?)(?:_total)?(?:\{[^}]*\})? (\S+)$/u.exec(line.trim());
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
