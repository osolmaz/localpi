import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { tokenStatusExtensionSource } from "../src/pi/extension-sources/token-status.js";
import {
  cleanupTemporaryDirs,
  loadGeneratedExtension,
  makeTemporaryDir
} from "./support/extension-harness.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

type ThemeCall = { readonly color: string; readonly text: string };

type Theme = {
  readonly fg: (color: string, text: string) => string;
  readonly bold: (text: string) => string;
};

type Renderer = (
  entry: { readonly data: unknown },
  options: { readonly expanded: boolean },
  theme: Theme
) => { readonly render: (width: number) => string[] };

type Command = {
  readonly handler: (args: string, ctx: unknown) => Promise<void>;
  readonly getArgumentCompletions?: (prefix: string) => unknown;
};

type ContextUsage = {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
};

type FakePi = {
  readonly handlers: Map<string, Handler>;
  readonly entries: { readonly type: string; readonly data: unknown }[];
  readonly renderers: Map<string, Renderer>;
  readonly commands: Map<string, Command>;
  readonly on: (event: string, handler: Handler) => void;
  readonly appendEntry: (type: string, data?: unknown) => void;
  readonly registerEntryRenderer: (type: string, renderer: Renderer) => void;
  readonly registerCommand: (name: string, command: Command) => void;
};

type FakeContext = {
  readonly hasUI: boolean;
  readonly ui: {
    readonly theme: Theme;
    readonly themeCalls: ThemeCall[];
    readonly messages: (string | undefined)[];
    readonly statuses: (string | undefined)[];
    readonly notifications: string[];
    readonly setWorkingMessage: (message?: string) => void;
    readonly setStatus: (key: string, text: string | undefined) => void;
    readonly notify: (message: string) => void;
    readonly select: (title: string, options: string[]) => Promise<string | undefined>;
  };
  readonly getContextUsage: () => ContextUsage | undefined;
};

type StatsEntryData = {
  readonly rate?: number;
  readonly output?: number;
  readonly input?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly prefillSeconds?: number;
  readonly elapsedSeconds?: number;
  readonly contextTokens?: number;
  readonly contextWindow?: number;
  readonly contextPercent?: number;
};

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await cleanupTemporaryDirs();
});

describe("generated localpi stats extension", () => {
  it("shows decode speed and context usage next to Working", async () => {
    setupClock();
    const { extension, settingsPath } = await loadExtension({ mode: "full" });
    const pi = fakePi();
    extension(pi);
    const ctx = fakeContext({ usage: contextUsage(34_000, 131_000) });

    vi.setSystemTime(1_000);
    pi.handlers.get("turn_start")?.({}, ctx);
    vi.setSystemTime(1_200);
    pi.handlers.get("message_update")?.(update("x".repeat(400)), ctx);
    vi.setSystemTime(3_000);
    pi.handlers.get("message_update")?.(update(""), ctx);

    const message = ctx.ui.messages.at(-1) ?? "";
    expect(message).toContain("Working");
    expect(message).toContain("100 out");
    expect(message).toContain("55.6 tok/s");
    expect(message).toContain("ctx 34k/131k (26%)");
    expect(themeColor(ctx, "accent", "55.6 tok/s")).toBe(true);
    expect(await exists(settingsPath)).toBe(false);
  });

  it("shows llama.cpp prefill progress from the slots endpoint", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            {
              is_processing: true,
              n_prompt_tokens: 20_000,
              n_prompt_tokens_processed: 5_000
            }
          ]),
          { status: 200 }
        )
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    setupClock();
    const { extension } = await loadExtension({
      mode: "full",
      engine: "llama-cpp",
      baseUrl: "http://127.0.0.1:8080/v1",
      modelId: "local-model"
    });
    const pi = fakePi();
    extension(pi);
    const ctx = fakeContext({ usage: contextUsage(20_000, 32_768) });

    vi.setSystemTime(1_000);
    pi.handlers.get("turn_start")?.({}, ctx);
    vi.setSystemTime(1_300);
    await vi.advanceTimersByTimeAsync(300);
    pi.handlers.get("message_update")?.(update(""), ctx);

    const message = ctx.ui.messages.at(-1) ?? "";
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/slots?model=local-model",
      expect.anything()
    );
    expect(message).toContain("prefill 25%");
    expect(message).toContain("5k/20k tok");
    expect(message).toContain("ctx 20k/33k (61%)");
  });

  it("falls back to elapsed prefill time when the slots endpoint fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("connection refused")))
    );
    setupClock();
    const { extension } = await loadExtension({
      mode: "full",
      engine: "llama-cpp",
      baseUrl: "http://127.0.0.1:8080/v1",
      modelId: "local-model"
    });
    const pi = fakePi();
    extension(pi);
    const ctx = fakeContext();

    vi.setSystemTime(1_000);
    pi.handlers.get("turn_start")?.({}, ctx);
    await vi.advanceTimersByTimeAsync(300);
    vi.setSystemTime(2_200);
    pi.handlers.get("message_update")?.(update(""), ctx);

    const message = ctx.ui.messages.at(-1) ?? "";
    expect(message).toContain("prefill 1.2s");
    expect(message).not.toContain("prefill 0%");
  });

  it("appends a transcript summary after the turn without a footer item", async () => {
    setupClock();
    const { extension } = await loadExtension({ mode: "full" });
    const pi = fakePi();
    extension(pi);
    const ctx = fakeContext({ usage: contextUsage(34_000, 131_000) });

    vi.setSystemTime(1_000);
    pi.handlers.get("turn_start")?.({}, ctx);
    vi.setSystemTime(1_400);
    pi.handlers.get("message_update")?.(update("y".repeat(4_000)), ctx);
    vi.setSystemTime(11_400);
    pi.handlers.get("turn_end")?.(
      { message: assistantMessage({ input: 8_400, output: 438 }) },
      ctx
    );

    const data = statsEntry(pi);
    expect(data.output).toBe(438);
    expect(data.input).toBe(8_400);
    expect(data.elapsedSeconds).toBeCloseTo(10.4, 1);
    expect(data.contextTokens).toBe(34_000);
    expect(data.contextWindow).toBe(131_000);
    expect(data.contextPercent).toBeCloseTo(25.954, 3);
    expect(ctx.ui.statuses).toHaveLength(0);
    expect(ctx.ui.messages.at(-1)).toBeUndefined();
  });

  it("renders the transcript summary as one plain line", async () => {
    setupClock();
    const { extension } = await loadExtension({ mode: "full" });
    const pi = fakePi();
    extension(pi);
    const ctx = fakeContext({ usage: contextUsage(34_000, 131_000) });

    vi.setSystemTime(1_000);
    pi.handlers.get("turn_start")?.({}, ctx);
    vi.setSystemTime(1_400);
    pi.handlers.get("message_update")?.(update("y".repeat(40)), ctx);
    vi.setSystemTime(11_400);
    pi.handlers.get("turn_end")?.(
      { message: assistantMessage({ input: 8_400, output: 438 }) },
      ctx
    );

    const data = statsEntry(pi);
    const renderer = pi.renderers.get("localpi-stats");
    expect(renderer).toBeDefined();
    const rendered = renderer?.({ data }, { expanded: false }, ctx.ui.theme).render(200) ?? [];
    expect(rendered).toHaveLength(1);
    const line = rendered.join("");
    expect(line).toContain("438 out");
    expect(line).toContain("8.4k in");
    expect(line).toContain("ctx 34k/131k (26%)");
    expect(line).toContain("prefill ");
    expect(line).toContain("tok/s");
  });

  it("keeps the working line only in line mode", async () => {
    setupClock();
    const { extension } = await loadExtension({ mode: "line" });
    const pi = fakePi();
    extension(pi);
    const ctx = fakeContext();

    vi.setSystemTime(1_000);
    pi.handlers.get("turn_start")?.({}, ctx);
    vi.setSystemTime(2_000);
    pi.handlers.get("turn_end")?.({ message: assistantMessage({ output: 10 }) }, ctx);

    expect(pi.entries).toHaveLength(0);
    expect(ctx.ui.statuses).toHaveLength(0);
    expect(ctx.ui.messages.some((message) => message?.includes("Working"))).toBe(true);
  });

  it("switches and persists the stats mode with /stats", async () => {
    setupClock();
    const { extension, settingsPath } = await loadExtension({ mode: "full" });
    const pi = fakePi();
    extension(pi);
    const ctx = fakeContext();

    const command = pi.commands.get("stats");
    expect(command).toBeDefined();
    await command?.handler("off", ctx);

    expect(ctx.ui.notifications.at(-1)).toBe("stats: off");
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({ stats: "off" });
    expect(await command?.getArgumentCompletions?.("li")).toEqual([
      { value: "line", label: "line" }
    ]);
  });
});

function setupClock(): void {
  vi.useFakeTimers();
}

function themeColor(ctx: FakeContext, color: string, text: string): boolean {
  return ctx.ui.themeCalls.some((call) => call.color === color && call.text.includes(text));
}

function statsEntry(pi: FakePi): StatsEntryData {
  const entry = pi.entries.at(-1);
  expect(entry?.type).toBe("localpi-stats");
  return entry?.data as StatsEntryData;
}

function update(delta: string): unknown {
  return { assistantMessageEvent: { type: "text_delta", delta }, message: {} };
}

function assistantMessage(usage: Record<string, number>): unknown {
  return { role: "assistant", content: "", usage };
}

function contextUsage(tokens: number, contextWindow: number): ContextUsage {
  return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}

function fakePi(): FakePi {
  const handlers = new Map<string, Handler>();
  const entries: { type: string; data: unknown }[] = [];
  const renderers = new Map<string, Renderer>();
  const commands = new Map<string, Command>();
  return {
    handlers,
    entries,
    renderers,
    commands,
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    appendEntry: (type, data) => {
      entries.push({ type, data });
    },
    registerEntryRenderer: (type, renderer) => {
      renderers.set(type, renderer);
    },
    registerCommand: (name, command) => {
      commands.set(name, command);
    }
  };
}

function fakeContext(options: { readonly usage?: ContextUsage } = {}): FakeContext {
  const messages: (string | undefined)[] = [];
  const statuses: (string | undefined)[] = [];
  const notifications: string[] = [];
  const themeCalls: ThemeCall[] = [];
  return {
    hasUI: true,
    ui: {
      theme: {
        fg: (color, text) => {
          themeCalls.push({ color, text });
          return text;
        },
        bold: (text) => text
      },
      themeCalls,
      messages,
      statuses,
      notifications,
      setWorkingMessage: (message) => {
        messages.push(message);
      },
      setStatus: (_key, text) => {
        statuses.push(text);
      },
      notify: (message) => {
        notifications.push(message);
      },
      select: () => Promise.resolve(undefined)
    },
    getContextUsage: () => options.usage
  };
}

async function loadExtension(config: {
  readonly mode: "off" | "line" | "full";
  readonly engine?: "llama-cpp";
  readonly baseUrl?: string;
  readonly modelId?: string;
}): Promise<{ readonly extension: (pi: unknown) => void; readonly settingsPath: string }> {
  const dir = await makeTemporaryDir("localpi-stats-");
  const settingsPath = path.join(dir, "settings.json");
  const extension = await loadGeneratedExtension(
    tokenStatusExtensionSource({ settingsPath, ...config })
  );
  return { extension, settingsPath };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
  }
}
