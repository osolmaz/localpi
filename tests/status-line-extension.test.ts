import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { statusLineExtensionSource } from "../src/pi/extension-sources/status-line.js";
import { cleanupTemporaryDirs, loadGeneratedExtension } from "./support/extension-harness.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

type ThemeCall = { readonly color: string; readonly text: string };

type Theme = {
  readonly fg: (color: string, text: string) => string;
};

type FooterComponent = {
  readonly render: (width: number) => string[];
  readonly dispose?: () => void;
};

type FooterFactory = (
  tui: { readonly requestRender: () => void },
  theme: Theme,
  footerData: {
    readonly getGitBranch: () => string | undefined;
    readonly getExtensionStatuses: () => Map<string, string>;
    readonly onBranchChange: (callback: () => void) => () => void;
  }
) => FooterComponent;

type Usage = {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cost?: { readonly total?: number };
};

type Entry =
  | { readonly type: "usage"; readonly usage: Usage }
  | {
      readonly type: "message";
      readonly message: { readonly role: string; readonly usage?: Usage };
    };

type ContextUsage = {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
};

type FakeContext = {
  readonly mode: string;
  readonly cwd: string;
  readonly model?: {
    readonly id: string;
    readonly provider: string;
    readonly reasoning?: boolean;
  };
  readonly thinkingLevel?: string;
  readonly sessionManager: {
    readonly getEntries: () => readonly Entry[];
    readonly getCwd: () => string;
    readonly getSessionName: () => string | undefined;
  };
  readonly getContextUsage: () => ContextUsage | undefined;
  readonly isIdle: () => boolean;
  readonly ui: {
    readonly themeCalls: ThemeCall[];
    footer: FooterFactory | undefined;
    readonly setFooter: (factory: FooterFactory | undefined) => void;
  };
};

type FakePi = {
  readonly handlers: Map<string, Handler>;
  readonly on: (event: string, handler: Handler) => void;
};

const engines = [{ provider: "llama-cpp", engine: "llama.cpp" }];

// The extension shortens the home directory to "~", so the fake working directory must live under
// the real home directory of whichever machine runs the test.
const fakeCwd = path.join(os.homedir(), "repos", "localpi");

function fakePi(): FakePi {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    on: (event, handler) => {
      handlers.set(event, handler);
    }
  };
}

function fakeContext(
  options: { readonly mode?: string; readonly usage?: ContextUsage; readonly idle?: boolean } = {}
): FakeContext {
  const themeCalls: ThemeCall[] = [];
  const context: FakeContext = {
    mode: options.mode ?? "tui",
    cwd: fakeCwd,
    model: { id: "ternary-bonsai-2-27b-pq2_0", provider: "llama-cpp" },
    isIdle: () => options.idle ?? true,
    sessionManager: {
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 3200, output: 100, cacheRead: 3200, cacheWrite: 0, cost: { total: 0 } }
          }
        }
      ],
      getCwd: () => fakeCwd,
      getSessionName: () => undefined
    },
    getContextUsage: () => options.usage ?? { tokens: 3200, contextWindow: 33_000, percent: 9.7 },
    ui: {
      themeCalls,
      footer: undefined,
      setFooter: (factory) => {
        context.ui.footer = factory;
      }
    }
  };
  return context;
}

function renderFooter(context: FakeContext, width = 150): string[] {
  const factory = context.ui.footer;
  if (factory === undefined) {
    throw new Error("the extension did not set a footer");
  }
  return factory(
    { requestRender: () => undefined },
    {
      fg: (color, text) => {
        context.ui.themeCalls.push({ color, text });
        return text;
      }
    },
    footerData()
  ).render(width);
}

function footerData(): {
  readonly getGitBranch: () => string | undefined;
  readonly getExtensionStatuses: () => Map<string, string>;
  readonly onBranchChange: (callback: () => void) => () => void;
} {
  return {
    getGitBranch: () => "main",
    getExtensionStatuses: () => new Map<string, string>(),
    onBranchChange: () => () => undefined
  };
}

function lastTurnBridge(): { lastTurn?: { rate?: number | undefined } | undefined } {
  const holder = globalThis as unknown as {
    localpiStats?: { lastTurn?: { rate?: number | undefined } | undefined };
  };
  holder.localpiStats ??= {};
  return holder.localpiStats;
}

async function loadExtension(): Promise<(pi: unknown) => void> {
  return loadGeneratedExtension(statusLineExtensionSource({ engines }));
}

describe("generated localpi status line", () => {
  afterEach(async () => {
    await cleanupTemporaryDirs();
    vi.restoreAllMocks();
    lastTurnBridge().lastTurn = undefined;
  });

  it("renders one line with the engine next to the model", async () => {
    const extension = await loadExtension();
    const pi = fakePi();
    extension(pi);
    const context = fakeContext();
    pi.handlers.get("session_start")?.({}, context);

    const lines = renderFooter(context);

    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    expect(line).toContain("(llama.cpp) ternary-bonsai-2-27b-pq2_0");
    expect(line).toContain("~/repos/localpi (main)");
    expect(line).toContain("↑3.2k");
    expect(line).toContain("↓100");
    expect(line).toContain("R3.2k");
    expect(line).toContain("CH50.0%");
    expect(line).toContain("9.7%/33k");
    expect(line).toHaveLength(150);
  });

  it("paints the engine, the context, and the statuses from the theme", async () => {
    const extension = await loadExtension();
    const pi = fakePi();
    extension(pi);
    const context = fakeContext({
      usage: { tokens: 29_000, contextWindow: 33_000, percent: 87.9 }
    });
    pi.handlers.get("session_start")?.({}, context);

    renderFooter(context);

    const calls = context.ui.themeCalls.map((call) => `${call.color}:${call.text}`);
    expect(calls).toContain("muted:(llama.cpp)");
    expect(calls).toContain("dim:ternary-bonsai-2-27b-pq2_0");
    expect(calls).toContain("warning:87.9%/33k");
  });

  it("marks a nearly full context window as an error", async () => {
    const extension = await loadExtension();
    const pi = fakePi();
    extension(pi);
    const context = fakeContext({ usage: { tokens: 32_000, contextWindow: 33_000, percent: 97 } });
    pi.handlers.get("session_start")?.({}, context);

    renderFooter(context);

    expect(context.ui.themeCalls.map((call) => `${call.color}:${call.text}`)).toContain(
      "error:97.0%/33k"
    );
  });

  it("keeps the context and the model when the line is narrow", async () => {
    const extension = await loadExtension();
    const pi = fakePi();
    extension(pi);
    const context = fakeContext();
    pi.handlers.get("session_start")?.({}, context);

    const line = renderFooter(context, 60)[0] ?? "";

    expect(line).not.toContain("~/repos/localpi");
    expect(line).not.toContain("↑3.2k");
    expect(line).toContain("9.7%/33k");
    expect(line).toContain("(llama.cpp) ternary-bonsai-2-27b-pq2_0");
    expect(line).toHaveLength(60);
  });

  it("truncates the model when the line cannot hold it", async () => {
    const extension = await loadExtension();
    const pi = fakePi();
    extension(pi);
    const context = fakeContext();
    pi.handlers.get("session_start")?.({}, context);

    const line = renderFooter(context, 24)[0] ?? "";

    expect(line).toHaveLength(24);
    expect(line).toContain("(llama.cpp)");
    expect(line).not.toContain("ternary-bonsai-2-27b-pq2_0");
  });

  it("survives a null branch and session name", async () => {
    const extension = await loadExtension();
    const pi = fakePi();
    extension(pi);
    const context = fakeContext();
    pi.handlers.get("session_start")?.({}, context);
    const factory = context.ui.footer;

    const lines = factory?.(
      { requestRender: () => undefined },
      { fg: (_color, text) => text },
      {
        getGitBranch: () => null as unknown as undefined,
        getExtensionStatuses: () => new Map(),
        onBranchChange: () => () => undefined
      }
    ).render(150);

    expect(lines?.[0]).toContain("~/repos/localpi");
  });

  it("hides the context in the footer while the model runs", async () => {
    const extension = await loadExtension();
    const pi = fakePi();
    extension(pi);
    const context = fakeContext({ idle: false });
    pi.handlers.get("session_start")?.({}, context);

    const line = renderFooter(context)[0] ?? "";

    expect(line).not.toContain("9.7%/33k");
    expect(line).toContain("(llama.cpp) ternary-bonsai-2-27b-pq2_0");
  });

  it("keeps the rate of the last completed turn while the model is idle", async () => {
    const extension = await loadExtension();
    const pi = fakePi();
    extension(pi);
    const context = fakeContext();
    pi.handlers.get("session_start")?.({}, context);
    lastTurnBridge().lastTurn = { rate: 24.13 };

    const line = renderFooter(context)[0] ?? "";

    expect(line).toContain("24.1 tok/s");
    expect(context.ui.themeCalls.map((call) => `${call.color}:${call.text}`)).toContain(
      "muted:24.1 tok/s"
    );
  });

  it("hides the rate while the model runs and before a turn finishes", async () => {
    const extension = await loadExtension();
    const pi = fakePi();
    extension(pi);
    const working = fakeContext({ idle: false });
    pi.handlers.get("session_start")?.({}, working);
    lastTurnBridge().lastTurn = { rate: 24.13 };

    expect(renderFooter(working)[0] ?? "").not.toContain("tok/s");

    const idle = fakeContext();
    pi.handlers.get("session_start")?.({}, idle);
    lastTurnBridge().lastTurn = undefined;

    expect(renderFooter(idle)[0] ?? "").not.toContain("tok/s");
  });

  it("shows the extension statuses on the same line", async () => {
    const extension = await loadExtension();
    const pi = fakePi();
    extension(pi);
    const context = fakeContext();
    pi.handlers.get("session_start")?.({}, context);

    const factory = context.ui.footer;
    const component = factory?.(
      { requestRender: () => undefined },
      { fg: (_color, text) => text },
      {
        getGitBranch: () => undefined,
        getExtensionStatuses: () => new Map([["localpi-approval", "permission: allow"]]),
        onBranchChange: () => () => undefined
      }
    );

    expect(component?.render(150)[0]).toContain("permission: allow");
  });

  it("shows the thinking level for a reasoning model", async () => {
    const extension = await loadExtension();
    const pi = fakePi();
    extension(pi);
    const context: FakeContext = {
      ...fakeContext(),
      model: { id: "reasoner", provider: "llama-cpp", reasoning: true },
      thinkingLevel: "high"
    };
    pi.handlers.get("session_start")?.({}, context);

    expect(renderFooter(context)[0]).toContain("(llama.cpp) reasoner • high");
  });

  it("shows no engine for a model from an unknown provider", async () => {
    const extension = await loadExtension();
    const pi = fakePi();
    extension(pi);
    const context: FakeContext = {
      ...fakeContext(),
      model: { id: "remote-model", provider: "some-endpoint" }
    };
    pi.handlers.get("session_start")?.({}, context);

    const line = renderFooter(context)[0] ?? "";
    expect(line).toContain("remote-model");
    expect(line).not.toContain("llama.cpp");
  });

  it("restores Pi's footer on shutdown", async () => {
    const extension = await loadExtension();
    const pi = fakePi();
    extension(pi);
    const context = fakeContext();
    pi.handlers.get("session_start")?.({}, context);
    expect(context.ui.footer).toBeDefined();

    pi.handlers.get("session_shutdown")?.({}, context);

    expect(context.ui.footer).toBeUndefined();
  });

  it("does not touch the footer outside the TUI", async () => {
    const extension = await loadExtension();
    const pi = fakePi();
    extension(pi);
    const context = fakeContext({ mode: "print" });

    pi.handlers.get("session_start")?.({}, context);

    expect(context.ui.footer).toBeUndefined();
  });
});
