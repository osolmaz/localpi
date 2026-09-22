import { afterEach, describe, expect, it } from "vitest";

import { approvalExtensionSource } from "../src/pi/extension-sources/tool-approval.js";
import { cleanupTemporaryDirs, loadGeneratedExtension } from "./support/extension-harness.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

type Command = {
  readonly handler: (args: string, ctx: unknown) => Promise<void>;
  readonly getArgumentCompletions?: (prefix: string) => unknown;
};

type FakePi = {
  readonly handlers: Map<string, Handler>;
  readonly commands: Map<string, Command>;
  readonly on: (event: string, handler: Handler) => void;
  readonly registerCommand: (name: string, command: Command) => void;
};

type FakeContext = {
  readonly ctx: unknown;
  readonly confirmCalls: string[];
  readonly statuses: (string | undefined)[];
  readonly notifications: string[];
};

afterEach(async () => {
  await cleanupTemporaryDirs();
});

describe("generated localpi tool approval extension", () => {
  it("asks before a tool call and allows it after confirmation", async () => {
    const pi = await enabledPi();
    const fake = fakeContext({ confirm: true });

    const result = await callTool(pi, fake);

    expect(result).toBeUndefined();
    expect(fake.confirmCalls).toHaveLength(1);
    expect(fake.confirmCalls[0]).toContain("Allow tool call: bash?");
    expect(fake.confirmCalls[0]).toContain('"command": "ls"');
  });

  it("blocks a denied tool call and reports it to the model", async () => {
    const pi = await enabledPi();
    const fake = fakeContext({ confirm: false });

    const result = await callTool(pi, fake);

    expect(blockReason(result)).toBe("Tool call was blocked by the user and did not run.");
  });

  it("blocks tool calls without a terminal to confirm in", async () => {
    const pi = await enabledPi();
    const fake = fakeContext({ hasUI: false });

    const result = await callTool(pi, fake);

    expect(blockReason(result)).toContain("interactive approval is required");
    expect(fake.confirmCalls).toHaveLength(0);
  });

  it("appends the approval rule to the system prompt", async () => {
    const pi = await enabledPi();

    const result = await pi.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, {});

    expect(systemPromptOf(result)).toContain("base");
    expect(systemPromptOf(result)).toContain("Tool approval rule:");
  });

  it("turns approval off for the rest of the session", async () => {
    const pi = await enabledPi();
    const command = fakeContext();
    await pi.commands.get("approval")?.handler("off", command.ctx);

    expect(command.notifications.at(-1)).toBe(
      "approval: off for this session; tool calls run without asking"
    );
    expect(command.statuses.at(-1)).toBe("approval: off");

    const fake = fakeContext({ confirm: false });
    expect(await callTool(pi, fake)).toBeUndefined();
    expect(fake.confirmCalls).toHaveLength(0);
  });

  it("turns approval back on from the list of settings", async () => {
    const pi = await disabledPi();
    const started = fakeContext();
    pi.handlers.get("session_start")?.({}, started.ctx);
    expect(started.statuses.at(-1)).toBe("approval: off");

    const command = fakeContext({ select: "on" });
    await pi.commands.get("approval")?.handler("", command.ctx);

    expect(command.notifications.at(-1)).toBe("approval: on; tool calls ask before they run");
    expect(command.statuses.at(-1)).toBeUndefined();

    const fake = fakeContext({ confirm: false });
    expect(blockReason(await callTool(pi, fake))).toBe(
      "Tool call was blocked by the user and did not run."
    );
  });

  it("marks the current state in the settings list", async () => {
    const pi = await enabledPi();
    const listed: string[][] = [];
    const command = fakeContext({ select: "off (current)", onSelect: listed });

    await pi.commands.get("approval")?.handler("", command.ctx);

    expect(listed[0]).toEqual(["on (current)", "off"]);
    expect(command.statuses.at(-1)).toBe("approval: off");
  });

  it("completes and rejects command arguments", async () => {
    const pi = await enabledPi();
    const completions = pi.commands.get("approval")?.getArgumentCompletions;

    expect(completions?.("o")).toEqual([
      { value: "on", label: "on" },
      { value: "off", label: "off" }
    ]);
    expect(completions?.("off")).toEqual([{ value: "off", label: "off" }]);
    expect(completions?.("x")).toBeNull();
  });
});

async function enabledPi(): Promise<FakePi> {
  return startPi(true);
}

async function disabledPi(): Promise<FakePi> {
  return startPi(false);
}

async function startPi(enabled: boolean): Promise<FakePi> {
  const extension = await loadGeneratedExtension(approvalExtensionSource({ enabled }));
  const pi = fakePi();
  extension(pi);
  return pi;
}

function callTool(pi: FakePi, fake: FakeContext): unknown {
  return pi.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "ls" } }, fake.ctx);
}

function blockReason(result: unknown): string {
  const record = result as { readonly block?: boolean; readonly reason?: string } | undefined;
  expect(record?.block).toBe(true);
  return record?.reason ?? "";
}

function systemPromptOf(result: unknown): string {
  const record = result as { readonly systemPrompt?: string } | undefined;
  return record?.systemPrompt ?? "";
}

function fakePi(): FakePi {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  return {
    handlers,
    commands,
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    registerCommand: (name, command) => {
      commands.set(name, command);
    }
  };
}

function fakeContext(
  options: {
    readonly hasUI?: boolean;
    readonly confirm?: boolean;
    readonly select?: string;
    readonly onSelect?: string[][];
  } = {}
): FakeContext {
  const confirmCalls: string[] = [];
  const statuses: (string | undefined)[] = [];
  const notifications: string[] = [];
  const ctx = {
    hasUI: options.hasUI ?? true,
    ui: {
      confirm: (title: string, message: string) => {
        confirmCalls.push(title + "\n" + message);
        return Promise.resolve(options.confirm ?? true);
      },
      setStatus: (_key: string, text: string | undefined) => {
        statuses.push(text);
      },
      notify: (message: string) => {
        notifications.push(message);
      },
      select: (_title: string, choices: string[]) => {
        options.onSelect?.push(choices);
        return Promise.resolve(options.select);
      }
    }
  };
  return { ctx, confirmCalls, statuses, notifications };
}
