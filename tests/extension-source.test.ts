import ts from "typescript";
import { describe, expect, it } from "vitest";

import { demoModeExtensionSource } from "../src/pi/extension-sources/demo-mode.js";
import { diffusionCanvasExtensionSource } from "../src/pi/extension-sources/diffusion-canvas.js";
import { startupModelSelectorExtensionSource } from "../src/pi/extension-sources/startup-model-selector.js";
import { thinkingControlExtensionSource } from "../src/pi/extension-sources/thinking-control.js";
import { tokenStatusExtensionSource } from "../src/pi/extension-sources/token-status.js";
import { approvalExtensionSource } from "../src/pi/extension-sources/tool-approval.js";

describe("generated Pi extension sources", () => {
  const sources = [
    {
      fileName: "demo-mode.ts",
      source: demoModeExtensionSource({ initial: "Begin.", followup: "Continue." })
    },
    {
      fileName: "startup-model-selector.ts",
      source: startupModelSelectorExtensionSource({
        models: [{ provider: "lmstudio", id: "gemma" }]
      })
    },
    {
      fileName: "thinking-control.ts",
      source: thinkingControlExtensionSource("/tmp/localpi/settings.json")
    },
    { fileName: "tool-approval.ts", source: approvalExtensionSource() },
    { fileName: "token-status.ts", source: tokenStatusExtensionSource() },
    {
      fileName: "diffusion-canvas.ts",
      source: diffusionCanvasExtensionSource({
        metricsUrl: "http://127.0.0.1:8000/metrics",
        eventsUrl: "http://127.0.0.1:8000/v1/diffusion/events"
      })
    },
    {
      fileName: "diffusion-canvas-no-metrics.ts",
      source: diffusionCanvasExtensionSource(undefined)
    }
  ] as const;

  for (const { fileName, source } of sources) {
    it(`transpiles ${fileName}`, () => {
      const result = ts.transpileModule(source, {
        fileName,
        reportDiagnostics: true,
        compilerOptions: {
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          target: ts.ScriptTarget.ES2022,
          strict: true
        }
      });
      expect(formatDiagnostics(result.diagnostics ?? [])).toBe("");
    });
  }

  it("demo mode compacts before sending the next followup under context pressure", async () => {
    const pi = new DemoPiHarness();
    const extension = await loadDemoExtension(
      demoModeExtensionSource({ initial: "Begin.", followup: "Continue." })
    );
    extension(pi);

    pi.emitSessionStart({ mode: "tui", percent: 0 });
    await flushMicrotasks();
    expect(pi.sentMessages).toEqual([{ content: "Begin.", options: undefined }]);

    pi.emitTurnEnd({ mode: "tui", percent: 20, stopReason: "stop" });
    await flushMicrotasks();
    expect(pi.sentMessages).toHaveLength(2);
    expect(pi.sentMessages[1]).toEqual({
      content: "Continue.",
      options: { deliverAs: "followUp" }
    });

    pi.emitTurnEnd({ mode: "tui", percent: 72, stopReason: "length" });
    await flushMicrotasks();
    expect(pi.compactions).toHaveLength(1);
    expect(pi.sentMessages).toHaveLength(2);

    pi.completeCompaction();
    await flushMicrotasks();
    expect(pi.sentMessages).toHaveLength(3);
    expect(pi.sentMessages[2]).toEqual({
      content: "Continue.",
      options: { deliverAs: "followUp" }
    });
  });

  it("demo mode stops followups when compaction fails", async () => {
    const pi = new DemoPiHarness();
    const extension = await loadDemoExtension(
      demoModeExtensionSource({ initial: "Begin.", followup: "Continue." })
    );
    extension(pi);

    pi.emitSessionStart({ mode: "tui", percent: 0 });
    await flushMicrotasks();

    pi.emitTurnEnd({ mode: "tui", percent: 90, stopReason: "length" });
    await flushMicrotasks();
    expect(pi.compactions).toHaveLength(1);

    pi.failCompaction(new Error("summary model failed"));
    await flushMicrotasks();
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.notifications).toEqual([
      { message: "Demo compaction failed: summary model failed", type: "error" }
    ]);

    pi.emitTurnEnd({ mode: "tui", percent: 10, stopReason: "stop" });
    await flushMicrotasks();
    expect(pi.sentMessages).toHaveLength(1);
  });
});

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return diagnostics
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    .join("\n");
}

type DemoExtension = (pi: DemoPiHarness) => void;

type SentMessage = {
  readonly content: string;
  readonly options: { readonly deliverAs: "followUp" } | undefined;
};

type Notification = {
  readonly message: string;
  readonly type: "error";
};

type DemoContextOptions = {
  readonly mode: "tui" | "print";
  readonly percent: number | null;
};

type DemoTurnOptions = DemoContextOptions & {
  readonly stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
};

type DemoContext = {
  readonly mode: "tui" | "print";
  readonly model: { readonly contextWindow: number };
  readonly ui: {
    notify(message: string, type: "error"): void;
  };
  getContextUsage(): {
    readonly tokens: number | null;
    readonly contextWindow: number;
    readonly percent: number | null;
  };
  compact(options: {
    readonly customInstructions?: string;
    readonly onComplete?: (result: unknown) => void;
    readonly onError?: (error: Error) => void;
  }): void;
};

type SessionStartEvent = {
  readonly reason: "startup";
};

type TurnEndEvent = {
  readonly message: {
    readonly role: "assistant";
    readonly usage: {
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
      readonly totalTokens: number;
      readonly cost: {
        readonly input: number;
        readonly output: number;
        readonly cacheRead: number;
        readonly cacheWrite: number;
        readonly total: number;
      };
    };
    readonly stopReason: DemoTurnOptions["stopReason"];
  };
};

type SessionStartHandler = (event: SessionStartEvent, ctx: DemoContext) => void;
type TurnEndHandler = (event: TurnEndEvent, ctx: DemoContext) => void;
type ShutdownHandler = () => void;

class DemoPiHarness {
  readonly sentMessages: SentMessage[] = [];
  readonly compactions: {
    readonly customInstructions?: string;
    readonly onComplete?: (result: unknown) => void;
    readonly onError?: (error: Error) => void;
  }[] = [];
  readonly notifications: Notification[] = [];

  private readonly sessionStartHandlers: SessionStartHandler[] = [];
  private readonly turnEndHandlers: TurnEndHandler[] = [];
  private readonly shutdownHandlers: ShutdownHandler[] = [];

  on(event: "session_start", handler: SessionStartHandler): void;
  on(event: "turn_end", handler: TurnEndHandler): void;
  on(event: "session_shutdown", handler: ShutdownHandler): void;
  on(
    event: "session_start" | "turn_end" | "session_shutdown",
    handler: SessionStartHandler | TurnEndHandler | ShutdownHandler
  ): void {
    switch (event) {
      case "session_start":
        this.sessionStartHandlers.push(handler as SessionStartHandler);
        return;
      case "turn_end":
        this.turnEndHandlers.push(handler as TurnEndHandler);
        return;
      case "session_shutdown":
        this.shutdownHandlers.push(handler as ShutdownHandler);
        return;
    }
  }

  sendUserMessage(content: string, options?: { readonly deliverAs: "followUp" }): void {
    this.sentMessages.push({ content, options });
  }

  emitSessionStart(options: DemoContextOptions): void {
    const ctx = this.createContext(options);
    for (const handler of this.sessionStartHandlers) {
      handler({ reason: "startup" }, ctx);
    }
  }

  emitTurnEnd(options: DemoTurnOptions): void {
    const ctx = this.createContext(options);
    const totalTokens =
      options.percent === null ? 0 : Math.round((options.percent / 100) * 100_000);
    for (const handler of this.turnEndHandlers) {
      handler(
        {
          message: {
            role: "assistant",
            usage: {
              input: totalTokens,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            },
            stopReason: options.stopReason
          }
        },
        ctx
      );
    }
  }

  completeCompaction(): void {
    const compaction = this.compactions.at(-1);
    expect(compaction).toBeDefined();
    compaction?.onComplete?.({ summary: "done" });
  }

  failCompaction(error: Error): void {
    const compaction = this.compactions.at(-1);
    expect(compaction).toBeDefined();
    compaction?.onError?.(error);
  }

  private createContext(options: DemoContextOptions): DemoContext {
    return {
      mode: options.mode,
      model: { contextWindow: 100_000 },
      ui: {
        notify: (message, type) => {
          this.notifications.push({ message, type });
        }
      },
      getContextUsage: () => ({
        tokens: options.percent === null ? null : Math.round((options.percent / 100) * 100_000),
        contextWindow: 100_000,
        percent: options.percent
      }),
      compact: (compactionOptions) => {
        this.compactions.push(compactionOptions);
      }
    };
  }
}

async function loadDemoExtension(source: string): Promise<DemoExtension> {
  const result = ts.transpileModule(source, {
    fileName: "demo-mode.ts",
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      strict: true
    }
  });
  const encoded = Buffer.from(result.outputText, "utf8").toString("base64");
  const module = (await import(`data:text/javascript;base64,${encoded}`)) as {
    readonly default: DemoExtension;
  };
  return module.default;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
