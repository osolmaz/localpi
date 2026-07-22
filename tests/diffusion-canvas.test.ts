import { readFileSync } from "node:fs";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { diffusionCanvasExtensionPath } from "../src/pi/extensions.js";

describe("diffusion canvas extension behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shows noise for a commit burst and resolves it into the real text", async () => {
    const pi = new CanvasPiHarness();
    const extension = await loadExtension();
    extension(pi);

    pi.emitTurnStart();
    expect(pi.widgetFactory).toBeDefined();
    expect(pi.renderWidget(80).join("\n")).toContain("denoising canvas 1 server-side");

    const burst = "the quick brown fox jumps over the lazy dog and keeps going";
    pi.emitMessageUpdate(burst);

    const noisy = pi.renderWidget(80).join("\n");
    expect(noisy).toContain("[accent:");
    expect(noisy).not.toContain("the quick brown fox");

    vi.advanceTimersByTime(2000);
    const resolved = pi.renderWidget(80).join("\n");
    expect(resolved).toContain("the quick brown fox jumps over the lazy dog");
    expect(resolved).toContain("1 commits");
  });

  it("keeps upcoming-canvas noise between bursts and settles on turn end", async () => {
    const pi = new CanvasPiHarness();
    const extension = await loadExtension();
    extension(pi);

    pi.emitTurnStart();
    pi.emitMessageUpdate("first canvas text arrives here as one burst");
    vi.advanceTimersByTime(1200);
    // With Math.random mocked to 0.5, every noise glyph is the same character,
    // so upcoming-canvas noise renders as a long dim run of repeated glyphs.
    expect(pi.renderWidget(80).join("\n")).toMatch(/\[dim:(.)\1+\]/u);

    pi.emitMessageUpdate("second canvas text follows after a real denoising pause");
    vi.advanceTimersByTime(2000);
    const midTurn = pi.renderWidget(120).join("\n");
    expect(midTurn).toContain("second canvas text follows");

    pi.emitTurnEnd();
    const finished = pi.renderWidget(120).join("\n");
    expect(finished).toContain("2 commits");
    expect(finished).toContain("done");
    // Fully resolved turn collapses to the stats header: the message text is
    // already shown by Pi above the widget.
    expect(finished).not.toContain("second canvas text follows");
    expect(finished).not.toMatch(/\[dim:(.)\1+\]/u);
  });

  it("keeps resolving the final canvas after turn end, then collapses to stats", async () => {
    const pi = new CanvasPiHarness();
    const extension = await loadExtension();
    extension(pi);

    pi.emitTurnStart();
    pi.emitMessageUpdate("final canvas text arrives right before the turn ends");
    pi.emitTurnEnd();

    const stillAnimating = pi.renderWidget(120).join("\n");
    expect(stillAnimating).toContain("[accent:");
    expect(stillAnimating).toContain("done");

    vi.advanceTimersByTime(2000);
    const collapsed = pi.renderWidget(120);
    expect(collapsed).toHaveLength(1);
    expect(collapsed.join("\n")).toContain("done");
    expect(collapsed.join("\n")).not.toContain("final canvas text");
  });

  it("renders real canvas states from the diffusion events side channel", async () => {
    const sse = sseStream();
    const fetchMock = vi.fn<(input: string, init?: unknown) => Promise<unknown>>(() =>
      Promise.resolve(sse.response)
    );
    vi.stubGlobal("fetch", fetchMock);

    const pi = new CanvasPiHarness();
    const extension = await loadExtension({
      eventsUrl: "http://127.0.0.1:8000/v1/diffusion/events"
    });
    extension(pi);

    pi.emitTurnStart();
    await flushMicrotasks();
    // No subscription yet: it opens scoped once the request id is known.
    expect(fetchMock).not.toHaveBeenCalled();
    pi.emit("message_update", {
      assistantMessageEvent: { type: "start", partial: { responseId: "chatcmpl-1" } }
    });
    await flushMicrotasks();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8000/v1/diffusion/events?request_id=chatcmpl-1"
    );

    sse.push({ request_id: "chatcmpl-1", step: 3, text: "the qXick brZwn f#x" });
    await flushMicrotasks();

    const denoising = pi.renderWidget(80).join("\n");
    expect(denoising).toContain("live");
    expect(denoising).toContain("step 3");
    expect(denoising).toContain("[accent:the qXick brZwn f#x]");

    // The commit settles instantly: the emergence was already shown live.
    pi.emitMessageUpdate("the quick brown fox");
    const committed = pi.renderWidget(80).join("\n");
    expect(committed).toContain("[muted:the quick brown fox]");
    expect(committed).not.toContain("[accent:");

    // Next block starts denoising: its canvas renders after the settled text.
    sse.push({ request_id: "chatcmpl-1", step: 1, text: "jum%s over th* lazy" });
    await flushMicrotasks();
    const nextBlock = pi.renderWidget(80).join("\n");
    expect(nextBlock).toContain("[muted:the quick brown fox]");
    expect(nextBlock).toContain("[accent:jum%s over th* lazy]");

    pi.emitTurnEnd();
    const finished = pi.renderWidget(80);
    expect(finished).toHaveLength(1);
    expect(finished.join("\n")).toContain("done");
  });

  it("falls back to labeled simulation when the events endpoint is unavailable", async () => {
    const fetchMock = vi.fn<(input: string, init?: unknown) => Promise<unknown>>(() =>
      Promise.reject(new Error("connection refused"))
    );
    vi.stubGlobal("fetch", fetchMock);

    const pi = new CanvasPiHarness();
    const extension = await loadExtension({
      eventsUrl: "http://127.0.0.1:8000/v1/diffusion/events"
    });
    extension(pi);

    pi.emitTurnStart();
    await flushMicrotasks();
    expect(pi.renderWidget(120).join("\n")).toContain("simulated");

    // The id is known, so a scoped subscription is attempted and refused.
    pi.emit("message_update", {
      assistantMessageEvent: { type: "start", partial: { responseId: "chatcmpl-1" } }
    });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalled();
    expect(pi.renderWidget(120).join("\n")).toContain("simulated");

    pi.emitMessageUpdate("burst text arrives without a side channel");
    const noisy = pi.renderWidget(80).join("\n");
    expect(noisy).toContain("[accent:");
    expect(noisy).not.toContain("burst text arrives");
  });

  it("counts thinking and tool-call deltas as commits, ignores non-delta events", async () => {
    const pi = new CanvasPiHarness();
    const extension = await loadExtension();
    extension(pi);

    pi.emitTurnStart();
    pi.emitMessageUpdate("model thinks out loud here", "thinking_delta");
    vi.advanceTimersByTime(2000);
    expect(pi.renderWidget(120).join("\n")).toContain("model thinks out loud here");

    // Tool-call JSON paces the stats but never settles into the display text.
    pi.emitMessageUpdate('{"path":"/tmp/x"}', "toolcall_delta");
    expect(pi.renderWidget(120).join("\n")).toContain("2 commits");
    expect(pi.renderWidget(120).join("\n")).not.toContain('{"path":"/tmp/x"}');

    // Start/end/done markers carry no new tokens and are not commits.
    pi.emit("message_update", {
      assistantMessageEvent: { type: "text_end", content: "full text" }
    });
    pi.emit("message_update", { assistantMessageEvent: { type: "done" } });
    expect(pi.renderWidget(120).join("\n")).toContain("2 commits");
  });

  it("shows only the canvas matching the turn's responseId", async () => {
    const sse = sseStream();
    const fetchMock = vi.fn<(input: string, init?: unknown) => Promise<unknown>>(() =>
      Promise.resolve(sse.response)
    );
    vi.stubGlobal("fetch", fetchMock);

    const pi = new CanvasPiHarness();
    const extension = await loadExtension({
      eventsUrl: "http://127.0.0.1:8000/v1/diffusion/events"
    });
    extension(pi);

    pi.emitTurnStart();
    await flushMicrotasks();

    // Pi's stream start event delivers the server request id for this turn.
    pi.emit("message_update", {
      assistantMessageEvent: { type: "start", partial: { responseId: "chatcmpl-mine" } }
    });

    sse.push({ request_id: "chatcmpl-other", step: 9, text: "someone elses canvas" });
    await flushMicrotasks();
    expect(pi.renderWidget(80).join("\n")).not.toContain("someone elses canvas");

    sse.push({ request_id: "chatcmpl-mine", step: 1, text: "my canvas" });
    await flushMicrotasks();
    const rendered = pi.renderWidget(80).join("\n");
    expect(rendered).toContain("my canvas");
    expect(rendered).not.toContain("someone elses canvas");
    expect(rendered).toContain("step 1");
  });

  it("correlates the first canvas via the injected X-Request-Id header", async () => {
    const sse = sseStream();
    const fetchMock = vi.fn<(input: string, init?: unknown) => Promise<unknown>>(() =>
      Promise.resolve(sse.response)
    );
    vi.stubGlobal("fetch", fetchMock);

    const pi = new CanvasPiHarness();
    const extension = await loadExtension({
      eventsUrl: "http://127.0.0.1:8000/v1/diffusion/events"
    });
    extension(pi);

    pi.emitTurnStart();
    await flushMicrotasks();

    // The extension assigns the request id up front through the header, so
    // canvas events correlate before the server streams any completion chunk.
    const headers: Record<string, string | null> = {};
    pi.emit("before_provider_headers", { headers });
    const tag = headers["X-Request-Id"];
    expect(tag).toBeTruthy();

    sse.push({ request_id: `chatcmpl-${String(tag)}`, step: 1, text: "first denoise canvas" });
    await flushMicrotasks();
    expect(pi.renderWidget(80).join("\n")).toContain("first denoise canvas");
  });

  it("never subscribes before the responseId is known", async () => {
    const sse = sseStream();
    const fetchMock = vi.fn<(input: string, init?: unknown) => Promise<unknown>>(() =>
      Promise.resolve(sse.response)
    );
    vi.stubGlobal("fetch", fetchMock);

    const pi = new CanvasPiHarness();
    const extension = await loadExtension({
      eventsUrl: "http://127.0.0.1:8000/v1/diffusion/events"
    });
    extension(pi);

    pi.emitTurnStart();
    await flushMicrotasks();

    // Without a request id there is nothing to scope the subscription to, so
    // no canvas of any request (possibly another client's) ever arrives.
    expect(fetchMock).not.toHaveBeenCalled();

    pi.emit("message_update", {
      assistantMessageEvent: { type: "start", partial: { responseId: "chatcmpl-mine" } }
    });
    await flushMicrotasks();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8000/v1/diffusion/events?request_id=chatcmpl-mine"
    );
    sse.push({ request_id: "chatcmpl-mine", step: 2, text: "scoped canvas" });
    await flushMicrotasks();
    expect(pi.renderWidget(80).join("\n")).toContain("scoped canvas");
  });

  it("parses CRLF-framed SSE events", async () => {
    const sse = sseStream("\r\n");
    const fetchMock = vi.fn<(input: string, init?: unknown) => Promise<unknown>>(() =>
      Promise.resolve(sse.response)
    );
    vi.stubGlobal("fetch", fetchMock);

    const pi = new CanvasPiHarness();
    const extension = await loadExtension({
      eventsUrl: "http://127.0.0.1:8000/v1/diffusion/events"
    });
    extension(pi);

    pi.emitTurnStart();
    await flushMicrotasks();
    pi.emit("message_update", {
      assistantMessageEvent: { type: "start", partial: { responseId: "chatcmpl-1" } }
    });

    sse.push({ request_id: "chatcmpl-1", step: 4, text: "crlf framed canvas" });
    await flushMicrotasks();
    expect(pi.renderWidget(80).join("\n")).toContain("crlf framed canvas");
  });

  it("tracks a new responseId after a tool-call completion", async () => {
    const sse = sseStream();
    const fetchMock = vi.fn<(input: string, init?: unknown) => Promise<unknown>>(() =>
      Promise.resolve(sse.response)
    );
    vi.stubGlobal("fetch", fetchMock);

    const pi = new CanvasPiHarness();
    const extension = await loadExtension({
      eventsUrl: "http://127.0.0.1:8000/v1/diffusion/events"
    });
    extension(pi);

    pi.emitTurnStart();
    await flushMicrotasks();
    pi.emit("message_update", {
      assistantMessageEvent: { type: "start", partial: { responseId: "chatcmpl-first" } }
    });
    sse.push({ request_id: "chatcmpl-first", step: 1, text: "first completion canvas" });
    await flushMicrotasks();
    expect(pi.renderWidget(80).join("\n")).toContain("first completion canvas");

    // Second completion of the same turn (after a tool call): new id.
    pi.emit("message_update", {
      assistantMessageEvent: { type: "start", partial: { responseId: "chatcmpl-second" } }
    });
    expect(pi.renderWidget(80).join("\n")).not.toContain("first completion canvas");

    sse.push({ request_id: "chatcmpl-second", step: 3, text: "second completion canvas" });
    await flushMicrotasks();
    expect(pi.renderWidget(80).join("\n")).toContain("second completion canvas");
  });

  it("keeps the widget height constant and substitutes ambiguous-width glyphs", async () => {
    const sse = sseStream();
    const fetchMock = vi.fn<(input: string, init?: unknown) => Promise<unknown>>(() =>
      Promise.resolve(sse.response)
    );
    vi.stubGlobal("fetch", fetchMock);

    const pi = new CanvasPiHarness();
    const extension = await loadExtension({
      eventsUrl: "http://127.0.0.1:8000/v1/diffusion/events"
    });
    extension(pi);

    pi.emitTurnStart();
    await flushMicrotasks();
    pi.emit("message_update", {
      assistantMessageEvent: { type: "start", partial: { responseId: "chatcmpl-1" } }
    });

    // Emoji, Devanagari, and Arabic have terminal-dependent display widths;
    // one mispredicted cell desyncs the TUI's differential renderer. They
    // must render as the neutral substitute, while ASCII and unambiguously
    // wide CJK render as-is.
    sse.push({
      request_id: "chatcmpl-1",
      step: 3,
      text: "abc \u{1f600} \u0921\u0947 \u0645 \u6f22\u5b57 xyz"
    });
    await flushMicrotasks();

    const rendered = pi.renderWidget(80);
    const joined = rendered.join("\n");
    expect(joined).toContain("abc");
    expect(joined).toContain("xyz");
    expect(joined).toContain("\u6f22\u5b57");
    expect(joined).toContain("\u00b7");
    expect(joined).not.toContain("\u{1f600}");
    expect(joined).not.toContain("\u0921");

    // While active, the widget always occupies header + maxRows lines so the
    // TUI layout never grows and shrinks with the canvas (which would push
    // stale frames into terminal scrollback).
    expect(rendered).toHaveLength(5);
    pi.emitMessageUpdate("short");
    expect(pi.renderWidget(80)).toHaveLength(5);

    // Once done and resolved, it still collapses to the stats line.
    pi.emitTurnEnd();
    expect(pi.renderWidget(80)).toHaveLength(1);
  });

  it("shows the full canvas in live mode, ratcheting the widget height", async () => {
    const sse = sseStream();
    const fetchMock = vi.fn<(input: string, init?: unknown) => Promise<unknown>>(() =>
      Promise.resolve(sse.response)
    );
    vi.stubGlobal("fetch", fetchMock);

    const pi = new CanvasPiHarness();
    const extension = await loadExtension({
      eventsUrl: "http://127.0.0.1:8000/v1/diffusion/events"
    });
    extension(pi);

    pi.emitTurnStart();
    await flushMicrotasks();
    pi.emit("message_update", {
      assistantMessageEvent: { type: "start", partial: { responseId: "chatcmpl-1" } }
    });

    // A whole canvas block detokenizes far past the simulated 4-row window;
    // live mode must render all of it, not a truncated head.
    const words: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      words.push(`word${String(i)}`);
    }
    const canvas = `${words.join(" ")} FINAL-MARKER`;
    sse.push({ request_id: "chatcmpl-1", step: 2, text: canvas });
    await flushMicrotasks();

    const tall = pi.renderWidget(80);
    expect(tall.join("\n")).toContain("FINAL-MARKER");
    expect(tall.length).toBeGreaterThan(1 + 4);

    // A shorter canvas on a later step must not shrink the widget: the
    // height ratchets so the TUI layout stays stable within the turn.
    sse.push({ request_id: "chatcmpl-1", step: 3, text: "short canvas" });
    await flushMicrotasks();
    expect(pi.renderWidget(80)).toHaveLength(tall.length);

    pi.emitTurnEnd();
    expect(pi.renderWidget(80)).toHaveLength(1);
  });

  it("renders committed text and canvas as one continuous tail-windowed document", async () => {
    const sse = sseStream();
    const fetchMock = vi.fn<(input: string, init?: unknown) => Promise<unknown>>(() =>
      Promise.resolve(sse.response)
    );
    vi.stubGlobal("fetch", fetchMock);

    const pi = new CanvasPiHarness();
    const extension = await loadExtension({
      eventsUrl: "http://127.0.0.1:8000/v1/diffusion/events"
    });
    extension(pi);

    pi.emitTurnStart();
    await flushMicrotasks();
    pi.emit("message_update", {
      assistantMessageEvent: { type: "start", partial: { responseId: "chatcmpl-1" } }
    });
    sse.push({ request_id: "chatcmpl-1", step: 1, text: "first block resolving" });
    await flushMicrotasks();

    // Commit far more text than the live row cap can show at this width.
    const words: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      words.push(`w${String(i)}`);
    }
    pi.emitMessageUpdate(`${words.join(" ")} LAST-COMMITTED-WORD `);
    sse.push({ request_id: "chatcmpl-1", step: 1, text: "NEXT-CANVAS resolving here" });
    await flushMicrotasks();

    const rendered = pi.renderWidget(18);
    // Row packing splits words at 16 columns; flatten the styled rows back
    // into the document text to assert on content and ordering.
    // The stats line sits below the canvas rows so the document flows
    // straight from the message into the canvas with nothing in between.
    // (Truncated to the 16-column test width, hence the partial match.)
    expect(rendered[rendered.length - 1]).toContain("diffusion canva");
    const flattened = rendered
      .slice(0, -1)
      .map((line) =>
        line
          .replace(/^ /u, "")
          .replace(/\[\w+:/gu, "")
          .replace(/\]/gu, "")
      )
      .join("");
    // The window is the tail of the document: the oldest committed text has
    // scrolled out, the newest is still visible, and the next canvas
    // continues right after it (both runs share the document flow, so there
    // is no gap between the settled text and the resolving canvas).
    expect(flattened).not.toContain("w0 w1");
    expect(flattened).toContain("LAST-COMMITTED-WORD");
    expect(flattened).toContain("NEXT-CANVAS");
    expect(flattened.indexOf("NEXT-CANVAS")).toBeGreaterThan(
      flattened.indexOf("LAST-COMMITTED-WORD")
    );
  });

  it("settles simulated commits when the live stream arrives late", async () => {
    const sse = sseStream();
    const fetchMock = vi.fn<(input: string, init?: unknown) => Promise<unknown>>(() =>
      Promise.resolve(sse.response)
    );
    vi.stubGlobal("fetch", fetchMock);

    const pi = new CanvasPiHarness();
    const extension = await loadExtension({
      eventsUrl: "http://127.0.0.1:8000/v1/diffusion/events"
    });
    extension(pi);

    pi.emitTurnStart();
    await flushMicrotasks();
    pi.emit("message_update", {
      assistantMessageEvent: { type: "start", partial: { responseId: "chatcmpl-1" } }
    });

    // A commit animates in simulated mode before any canvas event arrives.
    pi.emitMessageUpdate("already committed prefix");
    expect(pi.renderWidget(120).join("\n")).not.toContain("already committed prefix");

    // The first live canvas switches renderers; the committed prefix must
    // settle instead of being dropped with the simulated animation cells.
    sse.push({ request_id: "chatcmpl-1", step: 5, text: "denoising tail" });
    await flushMicrotasks();
    const live = pi.renderWidget(120).join("\n");
    expect(live).toContain("[muted:already committed prefix]");
    expect(live).toContain("[accent:denoising tail]");
  });

  it("bounds the canvas buffer, never evicting the correlated request", async () => {
    const sse = sseStream();
    const fetchMock = vi.fn<(input: string, init?: unknown) => Promise<unknown>>(() =>
      Promise.resolve(sse.response)
    );
    vi.stubGlobal("fetch", fetchMock);

    const pi = new CanvasPiHarness();
    const extension = await loadExtension({
      eventsUrl: "http://127.0.0.1:8000/v1/diffusion/events"
    });
    extension(pi);

    pi.emitTurnStart();
    await flushMicrotasks();
    pi.emit("message_update", {
      assistantMessageEvent: { type: "start", partial: { responseId: "chatcmpl-mine" } }
    });

    // The correlated canvas arrives first, then a crowd of foreign requests
    // large enough to overflow the buffer cap; the correlated entry survives.
    sse.push({ request_id: "chatcmpl-mine", step: 2, text: "my surviving canvas" });
    for (let i = 0; i < 20; i += 1) {
      sse.push({ request_id: `chatcmpl-other-${String(i)}`, step: 1, text: "foreign canvas" });
    }
    await flushMicrotasks();

    const rendered = pi.renderWidget(80).join("\n");
    expect(rendered).toContain("my surviving canvas");
    expect(rendered).not.toContain("foreign canvas");
  });

  it("computes steps per canvas from vLLM diffusion metrics deltas", async () => {
    const fetchMock = vi
      .fn<(input: string, init?: unknown) => Promise<{ ok: boolean; text(): Promise<string> }>>()
      .mockResolvedValueOnce(metricsResponse(100, 3200, 320))
      .mockResolvedValueOnce(metricsResponse(200, 6400, 640));
    vi.stubGlobal("fetch", fetchMock);

    const pi = new CanvasPiHarness();
    const extension = await loadExtension({ metricsUrl: "http://127.0.0.1:8000/metrics" });
    extension(pi);

    pi.emitTurnStart();
    await flushMicrotasks();
    pi.emitMessageUpdate("some canvas text");
    pi.emitTurnEnd();
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8000/metrics");
    // delta: 100 steps, 3200 positions, 320 committed -> CL 32, 10 canvases,
    // 90 denoise steps -> 9.0 steps/canvas
    expect(pi.renderWidget(120).join("\n")).toContain("9.0 steps/canvas (server)");
  });

  it("derives server URLs from the active model's baseUrl when no env override is set", async () => {
    const fetchMock = vi
      .fn<(input: string, init?: unknown) => Promise<{ ok: boolean; text(): Promise<string> }>>()
      .mockResolvedValue(metricsResponse(0, 0, 0));
    vi.stubGlobal("fetch", fetchMock);

    const pi = new CanvasPiHarness({ baseUrl: "http://10.0.0.5:8000/v1" });
    const extension = await loadExtension();
    extension(pi);

    pi.emitTurnStart();
    await flushMicrotasks();

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://10.0.0.5:8000/metrics");
  });

  it("clears the widget and stops the ticker on session shutdown", async () => {
    const pi = new CanvasPiHarness();
    const extension = await loadExtension();
    extension(pi);

    pi.emitTurnStart();
    expect(pi.widgetFactory).toBeDefined();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    // The widget header replaces Pi's built-in working spinner row.
    expect(pi.workingVisible).toBe(false);

    pi.emitSessionShutdown();
    expect(pi.widgetCleared).toBe(true);
    expect(pi.workingVisible).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

type SseHarness = {
  readonly response: { ok: boolean; status: number; body: ReadableStream<Uint8Array> };
  push(event: { request_id: string; step: number; text: string }): void;
};

// Each `response` access hands out a fresh stream (the extension re-subscribes
// per completion); pushes go to the most recently opened stream.
function sseStream(lineEnding = "\n"): SseHarness {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  return {
    get response() {
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController;
        }
      });
      return { ok: true, status: 200, body };
    },
    push: (event) => {
      controller?.enqueue(
        encoder.encode(`data: ${JSON.stringify(event)}${lineEnding}${lineEnding}`)
      );
    }
  };
}

function metricsResponse(
  steps: number,
  positions: number,
  committed: number
): { ok: boolean; text(): Promise<string> } {
  const body = [
    `vllm:diffusion_num_denoising_steps_total{model="m"} ${String(steps)}`,
    `vllm:diffusion_num_canvas_positions_total{model="m"} ${String(positions)}`,
    `vllm:diffusion_num_committed_tokens_total{model="m"} ${String(committed)}`
  ].join("\n");
  return {
    ok: true,
    text: () => Promise.resolve(body)
  };
}

type CanvasExtension = (pi: CanvasPiHarness) => void;

type WidgetComponent = {
  render(width: number): string[];
  invalidate(): void;
};

type WidgetTui = {
  requestRender(): void;
};

type WidgetTheme = {
  fg(color: string, text: string): string;
};

type WidgetFactory = (tui: WidgetTui, theme: WidgetTheme) => WidgetComponent;

type CanvasContext = {
  readonly hasUI: boolean;
  readonly mode: string;
  readonly model?: { readonly baseUrl?: string };
  readonly ui: {
    setWidget(key: string, content: WidgetFactory | string[] | undefined): void;
    setWorkingVisible(visible: boolean): void;
  };
};

type Handler = (event: unknown, ctx: CanvasContext) => void;

class CanvasPiHarness {
  widgetFactory: WidgetFactory | undefined;
  widgetCleared = false;
  workingVisible = true;

  private component: WidgetComponent | undefined;
  private readonly handlers = new Map<string, Handler[]>();
  private readonly ctx: CanvasContext;

  constructor(model?: { readonly baseUrl?: string }) {
    this.ctx = this.createContext(model);
  }

  private createContext(model?: { readonly baseUrl?: string }): CanvasContext {
    return {
      hasUI: true,
      mode: "tui",
      ...(model === undefined ? {} : { model }),
      ui: {
        setWidget: (_key, content) => {
          if (content === undefined) {
            this.widgetCleared = true;
            this.widgetFactory = undefined;
            this.component = undefined;
            return;
          }
          if (typeof content === "function") {
            this.widgetFactory = content;
            this.component = content({ requestRender: () => undefined }, themeStub());
          }
        },
        setWorkingVisible: (visible) => {
          this.workingVisible = visible;
        }
      }
    };
  }

  on(event: string, handler: Handler): void {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
  }

  emitTurnStart(): void {
    this.emit("turn_start", {});
  }

  emitMessageUpdate(delta: string, type = "text_delta"): void {
    this.emit("message_update", { assistantMessageEvent: { type, delta } });
  }

  emitTurnEnd(): void {
    this.emit("turn_end", {});
  }

  emitSessionShutdown(): void {
    this.emit("session_shutdown", {});
  }

  renderWidget(width: number): string[] {
    expect(this.component).toBeDefined();
    return this.component?.render(width) ?? [];
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload, this.ctx);
    }
  }
}

function themeStub(): WidgetTheme {
  return {
    fg: (color, text) => `[${color}:${text}]`
  };
}

const packagedSource = readFileSync(diffusionCanvasExtensionPath(), "utf8");

type ServerUrls = {
  readonly eventsUrl?: string;
  readonly metricsUrl?: string;
};

// Loads the packaged extension (packages/diffusion-canvas). The extension
// resolves server URLs at turn start from env overrides or the active
// model's baseUrl; tests configure them through the env variables.
async function loadExtension(urls: ServerUrls = {}): Promise<CanvasExtension> {
  if (urls.eventsUrl === undefined) {
    delete process.env["PI_DIFFUSION_CANVAS_EVENTS_URL"];
  } else {
    process.env["PI_DIFFUSION_CANVAS_EVENTS_URL"] = urls.eventsUrl;
  }
  if (urls.metricsUrl === undefined) {
    delete process.env["PI_DIFFUSION_CANVAS_METRICS_URL"];
  } else {
    process.env["PI_DIFFUSION_CANVAS_METRICS_URL"] = urls.metricsUrl;
  }
  const result = ts.transpileModule(packagedSource, {
    fileName: "diffusion-canvas.ts",
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      strict: true
    }
  });
  const encoded = Buffer.from(result.outputText, "utf8").toString("base64");
  const module = (await import(`data:text/javascript;base64,${encoded}`)) as {
    readonly default: CanvasExtension;
  };
  return module.default;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
