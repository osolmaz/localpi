import http from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { splitPieces, SseRepacer, startSmoothStreamProxy } from "../src/localpi/smooth-stream.js";

function contentChunk(text: string, id = "chatcmpl-1"): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    model: "m",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
  })}`;
}

function reasoningChunk(text: string): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    model: "m",
    choices: [{ index: 0, delta: { reasoning: text }, finish_reason: null }]
  })}`;
}

function finishChunk(): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    model: "m",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
  })}`;
}

type ParsedEvent = {
  readonly content: string;
  readonly reasoning: string;
  readonly raw: string;
};

function parseEvents(events: readonly string[]): ParsedEvent[] {
  return events.map((event) => {
    const payload = event.replace(/^data: /u, "").trim();
    if (payload === "[DONE]") {
      return { content: "", reasoning: "", raw: payload };
    }
    const parsed = JSON.parse(payload) as {
      choices?: { delta?: { content?: string; reasoning?: string } }[];
    };
    const delta = parsed.choices?.[0]?.delta ?? {};
    return { content: delta.content ?? "", reasoning: delta.reasoning ?? "", raw: payload };
  });
}

describe("splitPieces", () => {
  it("keeps whitespace attached to the preceding word", () => {
    expect(splitPieces("one two  three\n")).toEqual(["one ", "two  ", "three\n"]);
  });

  it("slices long whitespace-free runs without cutting surrogate pairs", () => {
    const run = "\u{1F600}".repeat(30);
    const pieces = splitPieces(run);
    expect(pieces.join("")).toBe(run);
    for (const piece of pieces) {
      // No piece may start with a low surrogate or end with a high surrogate.
      expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(piece)).toBe(false);
    }
  });
});

describe("SseRepacer", () => {
  it("queues large content deltas and releases them gradually", () => {
    const repacer = new SseRepacer({ tickMs: 40, targetDrainMs: 400, minCharsPerTick: 4 });
    const text = "word ".repeat(100).trim();
    expect(repacer.push(contentChunk(text))).toEqual([]);
    expect(repacer.pending).toBe(text.length);

    let released = "";
    let ticks = 0;
    while (repacer.pending > 0 && ticks < 100) {
      const events = parseEvents(repacer.tick());
      released += events.map((event) => event.content).join("");
      ticks += 1;
    }
    expect(released).toBe(text);
    // Backlog must drain within targetDrainMs/tickMs ticks (plus rounding).
    expect(ticks).toBeLessThanOrEqual(11);
    expect(ticks).toBeGreaterThan(3);
  });

  it("queues barrier events behind pending text instead of flushing it", () => {
    const repacer = new SseRepacer({ tickMs: 40, targetDrainMs: 400, minCharsPerTick: 4 });
    repacer.push(contentChunk("all of the committed text"));
    // The finish chunk right after a commit must not undo the pacing.
    expect(repacer.push(finishChunk())).toEqual([]);
    const outputs: string[] = [];
    while (repacer.queued > 0) {
      outputs.push(...repacer.tick());
    }
    const parsed = parseEvents(outputs);
    expect(parsed.length).toBeGreaterThan(2);
    expect(parsed.at(-1)?.raw).toContain('"finish_reason":"stop"');
    expect(
      parsed
        .slice(0, -1)
        .map((event) => event.content)
        .join("")
    ).toBe("all of the committed text");
  });

  it("re-paces reasoning deltas under the reasoning field", () => {
    const repacer = new SseRepacer({ tickMs: 40, targetDrainMs: 2000 });
    repacer.push(reasoningChunk("a longer plan that streams gradually"));
    const events = parseEvents(repacer.flush());
    expect(events.map((event) => event.reasoning).join("")).toBe(
      "a longer plan that streams gradually"
    );
    expect(events.every((event) => event.content === "")).toBe(true);
  });

  it("emits [DONE] only after the queued text drains", () => {
    const repacer = new SseRepacer();
    repacer.push(contentChunk("tail"));
    expect(repacer.push("data: [DONE]")).toEqual([]);
    const events = repacer.flush();
    expect(events.at(-1)).toBe("data: [DONE]\n\n");
    expect(parseEvents(events.slice(0, -1)).map((event) => event.content)).toEqual(["tail"]);
  });

  it("passes events straight through when nothing is queued", () => {
    const repacer = new SseRepacer();
    expect(repacer.push("data: [DONE]")).toEqual(["data: [DONE]\n\n"]);
  });

  it("keeps chunk metadata on re-emitted events", () => {
    const repacer = new SseRepacer();
    repacer.push(contentChunk("hello world", "chatcmpl-keep-me"));
    const events = repacer.flush();
    expect(events[0]).toContain('"id":"chatcmpl-keep-me"');
  });
});

describe("startSmoothStreamProxy", () => {
  it("re-paces streaming chat completions and passes other routes through", async () => {
    const bigText = "gradual ".repeat(120).trim();
    const upstream = http.createServer((request, response) => {
      if (request.url?.includes("/chat/completions") === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`${contentChunk(bigText)}\n\n`);
        response.write(`${finishChunk()}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("metrics-ok");
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const proxy = await startSmoothStreamProxy(`http://127.0.0.1:${String(upstreamPort)}/v1`, {
      tickMs: 10,
      targetDrainMs: 200
    });

    try {
      const passthrough = await fetch(proxy.baseUrl.replace(/\/v1$/u, "/metrics"));
      expect(await passthrough.text()).toBe("metrics-ok");

      const started = Date.now();
      const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream: true })
      });
      const body = await response.text();
      const elapsed = Date.now() - started;
      const events = body
        .split("\n\n")
        .filter((block) => block.startsWith("data: "))
        .map((block) => block.slice("data: ".length));
      expect(events.at(-1)).toBe("[DONE]");
      const contentEvents = events.filter((payload) => payload.includes('"content"'));
      expect(contentEvents.length).toBeGreaterThan(3);
      const reassembled = contentEvents
        .map((payload) => {
          const parsed = JSON.parse(payload) as {
            choices: { delta: { content?: string } }[];
          };
          return parsed.choices[0]?.delta.content ?? "";
        })
        .join("");
      expect(reassembled).toBe(bigText);
      // Draining should have taken a meaningful fraction of targetDrainMs.
      expect(elapsed).toBeGreaterThanOrEqual(100);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => {
        upstream.close(() => {
          resolve();
        });
      });
    }
  });
});
