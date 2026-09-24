import { afterEach, describe, expect, it, vi } from "vitest";

import { continueOnTruncationExtensionSource } from "../src/pi/extension-sources/continue-on-truncation.js";
import { cleanupTemporaryDirs, loadGeneratedExtension } from "./support/extension-harness.js";

type Handler = (event: unknown) => unknown;

type SentMessage = {
  readonly text: string;
  readonly options: unknown;
};

type FakePi = {
  readonly handlers: Map<string, Handler>;
  readonly messages: SentMessage[];
  readonly on: (event: string, handler: Handler) => void;
  readonly sendUserMessage: (text: string, options: unknown) => void;
};

afterEach(async () => {
  await cleanupTemporaryDirs();
  vi.restoreAllMocks();
});

describe("generated localpi continue on truncation extension", () => {
  it("continues once after a truncated turn", async () => {
    const stderr = captureStderr();
    try {
      const pi = await startPi(2);

      await pi.handlers.get("turn_end")?.(turnEnd("length"));

      expect(pi.messages).toHaveLength(1);
      expect(pi.messages[0]?.options).toEqual({ deliverAs: "followUp" });
      expect(pi.messages[0]?.text).toContain("Continue from where you stopped");
      expect(pi.messages[0]?.text).toContain("Do not repeat earlier text");
      expect(stderr).toHaveBeenCalledWith(
        "localpi: reply was cut off by the output limit; continuing (1/2)\n"
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("stops after the limit and reports it once", async () => {
    const stderr = captureStderr();
    try {
      const pi = await startPi(2);

      await pi.handlers.get("turn_end")?.(turnEnd("length"));
      await pi.handlers.get("turn_end")?.(turnEnd("length"));
      await pi.handlers.get("turn_end")?.(turnEnd("length"));
      await pi.handlers.get("turn_end")?.(turnEnd("length"));

      expect(pi.messages).toHaveLength(2);
      expect(stopLines(stderr)).toEqual([
        "localpi: reply was cut off again after 2 continuations; stopping now\n"
      ]);
    } finally {
      stderr.mockRestore();
    }
  });

  it("uses the singular form of continuation in the give-up line", async () => {
    const stderr = captureStderr();
    try {
      const pi = await startPi(1);

      await pi.handlers.get("turn_end")?.(turnEnd("length"));
      await pi.handlers.get("turn_end")?.(turnEnd("length"));

      expect(pi.messages).toHaveLength(1);
      expect(stopLines(stderr)).toEqual([
        "localpi: reply was cut off again after 1 continuation; stopping now\n"
      ]);
    } finally {
      stderr.mockRestore();
    }
  });

  it("leaves a turn that stopped normally alone", async () => {
    const pi = await startPi(2);

    await pi.handlers.get("turn_end")?.(turnEnd("stop"));

    expect(pi.messages).toHaveLength(0);
  });

  it("leaves a turn that stopped on an error alone", async () => {
    const pi = await startPi(2);

    await pi.handlers.get("turn_end")?.(turnEnd("error"));

    expect(pi.messages).toHaveLength(0);
  });

  it("leaves a truncated turn that already asked for tools alone", async () => {
    const pi = await startPi(2);

    await pi.handlers.get("turn_end")?.(turnEnd("length", 1));
    await pi.handlers.get("turn_end")?.(turnEnd("toolUse", 1));

    expect(pi.messages).toHaveLength(0);
  });

  it("starts over when a new session begins", async () => {
    const pi = await startPi(1);

    await pi.handlers.get("turn_end")?.(turnEnd("length"));
    await pi.handlers.get("turn_end")?.(turnEnd("length"));
    await pi.handlers.get("session_start")?.({});
    await pi.handlers.get("turn_end")?.(turnEnd("length"));

    expect(pi.messages).toHaveLength(2);
  });
});

async function startPi(limit: number): Promise<FakePi> {
  const extension = await loadGeneratedExtension(continueOnTruncationExtensionSource(limit));
  const handlers = new Map<string, Handler>();
  const messages: SentMessage[] = [];
  const pi: FakePi = {
    handlers,
    messages,
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    sendUserMessage: (text, options) => {
      messages.push({ text, options });
    }
  };
  extension(pi);
  return pi;
}

function turnEnd(stopReason: string, toolResults = 0): unknown {
  return {
    message: { role: "assistant", stopReason },
    toolResults: Array.from({ length: toolResults }, () => ({}))
  };
}

function captureStderr() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

function stopLines(stderr: ReturnType<typeof captureStderr>): string[] {
  return stderr.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes("stopping now"));
}
