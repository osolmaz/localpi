import http from "node:http";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";

// Diffusion servers commit whole canvases at once, so a streamed chat
// completion arrives as a few huge deltas and the TUI jumps by dozens of
// lines. The smooth-stream proxy sits between Pi and the OpenAI-compatible
// endpoint and re-paces those deltas: large content/reasoning chunks are split
// into word-sized pieces and drip-fed at a rate that always drains the backlog
// within targetDrainMs, so display lags bursts by at most that much and can
// never fall behind the model. Everything else (other routes, tool calls,
// finish chunks, usage, non-SSE responses) passes through untouched.

export type SmoothStreamOptions = {
  /** Milliseconds between drain ticks. */
  readonly tickMs?: number;
  /** Upper bound for how long a backlog may take to finish displaying. */
  readonly targetDrainMs?: number;
  /** Minimum characters released per tick once anything is queued. */
  readonly minCharsPerTick?: number;
};

export type SmoothStreamProxy = {
  /** OpenAI-compatible base URL ("http://127.0.0.1:PORT/v1") for clients. */
  readonly baseUrl: string;
  readonly port: number;
  close(): Promise<void>;
};

type ResolvedPacing = Required<SmoothStreamOptions>;

const defaultPacing: ResolvedPacing = {
  tickMs: 40,
  targetDrainMs: 2000,
  minCharsPerTick: 6
};

function resolvePacing(options: SmoothStreamOptions): ResolvedPacing {
  return { ...defaultPacing, ...options };
}

// A queued piece of assistant text plus the chunk JSON it came from, so the
// re-emitted event preserves the id/model/choice metadata of the original.
type QueuedText = {
  readonly kind: "text";
  readonly text: string;
  readonly template: ChunkTemplate;
};

// Any non-paceable event (role header, tool call, finish chunk, usage,
// [DONE]) queues behind pending text so ordering is preserved without
// flushing the backlog: a finish chunk right after a commit must not undo the
// pacing of that commit.
type QueuedEvent = {
  readonly kind: "event";
  readonly raw: string;
};

type QueueEntry = QueuedText | QueuedEvent;

type ChunkTemplate = {
  readonly chunk: Record<string, unknown>;
  readonly field: "content" | "reasoning";
};

type DeltaChunk = {
  readonly chunk: Record<string, unknown>;
  readonly delta: Record<string, unknown>;
};

/**
 * Re-paces the `data:` payloads of one SSE chat-completion stream.
 *
 * Time is injected: the caller invokes tick() on its own schedule, which makes
 * the pacing logic deterministic and directly testable. Output events are
 * already-serialized SSE blocks ("data: ...\n\n").
 */
export class SseRepacer {
  private readonly pacing: ResolvedPacing;
  private readonly queue: QueueEntry[] = [];
  // Chars per tick, locked in whenever the backlog grows so drain time is
  // linear (recomputing from the shrinking backlog would decay geometrically
  // and never hit the target).
  private rate = 0;

  constructor(options: SmoothStreamOptions = {}) {
    this.pacing = resolvePacing(options);
  }

  /** Characters of assistant text still queued. */
  get pending(): number {
    return this.queue.reduce(
      (total, entry) => total + (entry.kind === "text" ? entry.text.length : 0),
      0
    );
  }

  /** Total queued entries, including trailing non-text events. */
  get queued(): number {
    return this.queue.length;
  }

  get tickMs(): number {
    return this.pacing.tickMs;
  }

  /** Feed one SSE event block (without trailing blank line). */
  push(eventBlock: string): string[] {
    const payload = dataPayload(eventBlock);
    const paceable = payload === undefined ? undefined : paceableChunk(payload);
    if (paceable === undefined) {
      if (this.queue.length === 0) {
        return [`${eventBlock}\n\n`];
      }
      this.queue.push({ kind: "event", raw: `${eventBlock}\n\n` });
      return [];
    }
    for (const piece of splitPieces(textOf(paceable))) {
      this.queue.push({ kind: "text", text: piece, template: paceable });
    }
    const ticksToDrain = Math.max(1, Math.floor(this.pacing.targetDrainMs / this.pacing.tickMs));
    this.rate = Math.max(this.rate, Math.ceil(this.pending / ticksToDrain));
    return [];
  }

  /** Release the next slice of queued text plus any events it uncovers. */
  tick(): string[] {
    if (this.queue.length === 0) {
      this.rate = 0;
      return [];
    }
    return this.emit(Math.max(this.pacing.minCharsPerTick, this.rate));
  }

  /** Serialize everything still queued, in order. */
  flush(): string[] {
    return this.emit(Number.POSITIVE_INFINITY);
  }

  private emit(charBudget: number): string[] {
    const events: string[] = [];
    let spent = 0;
    while (spent < charBudget) {
      const head = this.queue[0];
      if (head === undefined) {
        break;
      }
      if (head.kind === "event") {
        this.queue.shift();
        events.push(head.raw);
        continue;
      }
      spent += this.emitTextRun(head.template, charBudget - spent, events);
    }
    if (this.queue.length === 0) {
      this.rate = 0;
    }
    return events;
  }

  /** Merge consecutive same-template pieces into one event, up to budget. */
  private emitTextRun(template: ChunkTemplate, budget: number, events: string[]): number {
    let text = "";
    let spent = 0;
    while (spent < budget) {
      const entry = this.queue[0];
      if (entry?.kind !== "text" || entry.template !== template) {
        break;
      }
      this.queue.shift();
      text += entry.text;
      spent += entry.text.length;
    }
    events.push(`data: ${renderChunk(template, text)}\n\n`);
    return spent;
  }
}

function dataPayload(eventBlock: string): string | undefined {
  const lines = eventBlock.split("\n");
  if (!lines.every((line) => line.startsWith("data:") || line.trim() === "")) {
    return undefined;
  }
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).replace(/^ /u, ""))
    .join("\n");
  return data === "" ? undefined : data;
}

function paceableChunk(payload: string): ChunkTemplate | undefined {
  if (payload.trim() === "[DONE]") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const chunk = parsed as Record<string, unknown>;
  const single = singleDelta(chunk);
  if (single === undefined) {
    return undefined;
  }
  const field = paceableField(single.delta);
  if (field === undefined) {
    return undefined;
  }
  return { chunk, field };
}

function singleDelta(chunk: Record<string, unknown>): DeltaChunk | undefined {
  const choice = singleChoice(chunk);
  if (choice === undefined || choice["finish_reason"] != null) {
    return undefined;
  }
  const delta = asRecord(choice["delta"]);
  return delta === undefined ? undefined : { chunk, delta };
}

function singleChoice(chunk: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = chunk["choices"];
  if (!Array.isArray(choices) || choices.length !== 1) {
    return undefined;
  }
  return asRecord(choices[0]);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function paceableField(delta: Record<string, unknown>): "content" | "reasoning" | undefined {
  if (delta["tool_calls"] !== undefined || delta["function_call"] !== undefined) {
    return undefined;
  }
  const content = stringField(delta["content"]);
  const reasoning = stringField(delta["reasoning"] ?? delta["reasoning_content"]);
  if (content !== undefined) {
    // A chunk carrying both fields is not paceable; the canvas fork already
    // splits those server-side, and passing it through keeps ordering exact.
    return reasoning !== undefined ? undefined : "content";
  }
  return reasoning !== undefined ? "reasoning" : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function textOf(template: ChunkTemplate): string {
  const delta = deltaOf(template.chunk);
  const value =
    template.field === "content"
      ? delta["content"]
      : (delta["reasoning"] ?? delta["reasoning_content"]);
  return typeof value === "string" ? value : "";
}

function deltaOf(chunk: Record<string, unknown>): Record<string, unknown> {
  const choices = chunk["choices"] as unknown[];
  const choice = choices[0] as Record<string, unknown>;
  return choice["delta"] as Record<string, unknown>;
}

const maxPieceLength = 24;

/**
 * Split text at whitespace boundaries (whitespace stays attached to the
 * preceding word). Runs without whitespace (e.g. CJK) fall back to fixed-size
 * code-point slices so surrogate pairs are never cut.
 */
export function splitPieces(text: string): string[] {
  const words = text.match(/\S+\s*|\s+/gu) ?? [];
  const pieces: string[] = [];
  for (const word of words) {
    if (word.length <= maxPieceLength) {
      pieces.push(word);
      continue;
    }
    let piece = "";
    for (const codePoint of word) {
      piece += codePoint;
      if (piece.length >= maxPieceLength) {
        pieces.push(piece);
        piece = "";
      }
    }
    if (piece !== "") {
      pieces.push(piece);
    }
  }
  return pieces;
}

function renderChunk(template: ChunkTemplate, text: string): string {
  const chunk = template.chunk;
  const choices = chunk["choices"] as unknown[];
  const choice = choices[0] as Record<string, unknown>;
  const delta = choice["delta"] as Record<string, unknown>;
  const newDelta: Record<string, unknown> = { ...delta };
  delete newDelta["content"];
  delete newDelta["reasoning"];
  delete newDelta["reasoning_content"];
  if (template.field === "content") {
    newDelta["content"] = text;
  } else if (delta["reasoning_content"] !== undefined) {
    newDelta["reasoning_content"] = text;
  } else {
    newDelta["reasoning"] = text;
  }
  return JSON.stringify({
    ...chunk,
    choices: [{ ...choice, delta: newDelta }]
  });
}

/**
 * Start the proxy. All routes are forwarded verbatim to the upstream base
 * (scheme+host of upstreamBaseUrl); only streaming chat completions are
 * re-paced.
 */
export async function startSmoothStreamProxy(
  upstreamBaseUrl: string,
  options: SmoothStreamOptions = {}
): Promise<SmoothStreamProxy> {
  const upstream = new URL(upstreamBaseUrl);
  const server = http.createServer((request, response) => {
    proxyRequest(upstream, request, response, options);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      })
  };
}

function proxyRequest(
  upstream: URL,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: SmoothStreamOptions
): void {
  const headers = { ...request.headers };
  delete headers.host;
  const upstreamRequest = http.request(
    {
      hostname: upstream.hostname,
      port: upstream.port === "" ? 80 : Number(upstream.port),
      path: request.url ?? "/",
      method: request.method,
      headers
    },
    (upstreamResponse) => {
      handleUpstreamResponse(request, response, upstreamResponse, options);
    }
  );
  upstreamRequest.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "text/plain" });
    }
    response.end("smooth-stream proxy: upstream unavailable\n");
  });
  request.pipe(upstreamRequest);
  request.on("aborted", () => {
    upstreamRequest.destroy();
  });
}

function handleUpstreamResponse(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  upstreamResponse: http.IncomingMessage,
  options: SmoothStreamOptions
): void {
  response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
  const contentType = upstreamResponse.headers["content-type"] ?? "";
  const isChatStream =
    contentType.includes("text/event-stream") && (request.url ?? "").includes("/chat/completions");
  if (!isChatStream) {
    upstreamResponse.pipe(response);
    // Long-lived pass-through streams (e.g. the diffusion events side
    // channel) must not keep the upstream socket open after the client left.
    response.on("close", () => {
      upstreamResponse.destroy();
    });
    return;
  }
  repaceSseResponse(response, upstreamResponse, options);
}

function repaceSseResponse(
  response: http.ServerResponse,
  upstreamResponse: http.IncomingMessage,
  options: SmoothStreamOptions
): void {
  const repacer = new SseRepacer(options);
  let buffer = "";
  let upstreamDone = false;

  const writeAll = (events: readonly string[]): void => {
    for (const event of events) {
      response.write(event);
    }
  };

  const timer = setInterval(() => {
    writeAll(repacer.tick());
    if (upstreamDone && repacer.queued === 0) {
      clearInterval(timer);
      response.end();
    }
  }, repacer.tickMs);

  upstreamResponse.on("data", (data: Buffer) => {
    buffer += data.toString("utf8");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary).replace(/\r/gu, "");
      buffer = buffer.slice(boundary + 2);
      if (block.trim() !== "") {
        writeAll(repacer.push(block));
      }
      boundary = buffer.indexOf("\n\n");
    }
  });
  upstreamResponse.on("end", () => {
    upstreamDone = true;
  });
  upstreamResponse.on("error", () => {
    upstreamDone = true;
  });
  response.on("close", () => {
    clearInterval(timer);
    upstreamResponse.destroy();
  });
}
