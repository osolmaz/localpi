import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { approvalExtensionSource } from "../src/pi/extension-sources/tool-approval.js";
import {
  cleanupTemporaryDirs,
  loadGeneratedExtension,
  makeTemporaryDir
} from "./support/extension-harness.js";

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
  readonly dialogs: string[];
  readonly choices: string[][];
  readonly statuses: (string | undefined)[];
  readonly notifications: string[];
};

const allowOnce = "Allow once";
const allowSession = "Allow all tools for this session";
const deny = "Deny and stop";

afterEach(async () => {
  await cleanupTemporaryDirs();
});

describe("generated localpi tool approval extension", () => {
  it("allows one tool call from the dialog and keeps asking afterwards", async () => {
    const { pi, settingsPath } = await enabledPi();
    const fake = fakeContext({ selections: [allowOnce] });

    const result = await callTool(pi, fake);

    expect(result).toBeUndefined();
    expect(fake.dialogs).toHaveLength(1);
    expect(fake.dialogs[0]).toContain("Allow tool call: bash?");
    expect(fake.dialogs[0]).toContain('"command": "ls"');
    expect(fake.choices[0]).toEqual([allowOnce, allowSession, deny]);
    await expect(readSettings(settingsPath)).resolves.toEqual({});

    const next = fakeContext({ selections: [allowOnce] });
    expect(await callTool(pi, next)).toBeUndefined();
    expect(next.dialogs).toHaveLength(1);
  });

  it("allows every tool call for the rest of the session from the dialog", async () => {
    const { pi, settingsPath } = await enabledPi();
    const fake = fakeContext({ selections: [allowSession] });

    const result = await callTool(pi, fake);

    expect(result).toBeUndefined();
    expect(fake.statuses.at(-1)).toBe("permission: allow");
    expect(fake.notifications.at(-1)).toBe(
      "permission: allow for this session; tool calls run without asking"
    );

    const next = fakeContext({ selections: [] });
    expect(await callTool(pi, next)).toBeUndefined();
    expect(next.dialogs).toHaveLength(0);
    await expect(readSettings(settingsPath)).resolves.toEqual({});
  });

  it("blocks a denied tool call, stops the turn, and reports it to the model", async () => {
    const { pi } = await enabledPi();
    const fake = fakeContext({ selections: [deny] });

    const result = await callTool(pi, fake);

    expect(blockReason(result)).toBe("Tool call was blocked by the user and did not run.");
    expect(terminates(result)).toBe(true);
  });

  it("blocks a cancelled dialog, stops the turn, and reports it to the model", async () => {
    const { pi } = await enabledPi();
    const fake = fakeContext({ selections: [] });

    const result = await callTool(pi, fake);

    expect(blockReason(result)).toBe("Tool call was blocked by the user and did not run.");
    expect(terminates(result)).toBe(true);
  });

  it("blocks tool calls without a terminal to confirm in", async () => {
    const { pi } = await enabledPi();
    const fake = fakeContext({ hasUI: false });

    const result = await callTool(pi, fake);

    expect(blockReason(result)).toContain("interactive approval is required");
    expect(terminates(result)).toBe(true);
    expect(fake.dialogs).toHaveLength(0);
  });

  it("runs read-only tools without asking and keeps bash behind the gate", async () => {
    const { pi } = await enabledPi();

    for (const toolName of ["read", "grep", "find", "ls"]) {
      const fake = fakeContext({ selections: [] });
      expect(await callToolNamed(pi, fake, toolName)).toBeUndefined();
      expect(fake.dialogs).toHaveLength(0);
    }

    const bash = fakeContext({ selections: [] });
    expect(blockReason(await callToolNamed(pi, bash, "bash"))).toBe(
      "Tool call was blocked by the user and did not run."
    );
    expect(bash.dialogs).toHaveLength(1);
  });

  it("keeps an unknown tool behind the gate", async () => {
    const { pi } = await enabledPi();
    const fake = fakeContext({ selections: [] });

    expect(blockReason(await callToolNamed(pi, fake, "mystery_tool"))).toBe(
      "Tool call was blocked by the user and did not run."
    );
    expect(fake.dialogs).toHaveLength(1);
  });

  it("asks before read-only tools when the read gate is on", async () => {
    const { pi } = await enabledPi({}, true, true);
    const fake = fakeContext({ selections: [allowOnce] });

    expect(await callToolNamed(pi, fake, "read")).toBeUndefined();
    expect(fake.dialogs).toHaveLength(1);
    expect(fake.dialogs[0]).toContain("Allow tool call: read?");
  });

  it("appends the approval rule to the system prompt", async () => {
    const { pi } = await enabledPi();

    const result = await pi.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, {});

    expect(systemPromptOf(result)).toContain("base");
    expect(systemPromptOf(result)).toContain("Tool approval rule:");
  });

  it("saves the permission setting when the command turns approval off", async () => {
    const { pi, settingsPath } = await enabledPi({ stats: "full" });
    const command = fakeContext();

    await pi.commands.get("approval")?.handler("off", command.ctx);

    expect(command.notifications.at(-1)).toBe(
      "permission: allow, saved for new sessions; tool calls run without asking"
    );
    expect(command.statuses.at(-1)).toBe("permission: allow");
    await expect(readSettings(settingsPath)).resolves.toEqual({
      stats: "full",
      permission: "allow"
    });

    const fake = fakeContext({ selections: [] });
    expect(await callTool(pi, fake)).toBeUndefined();
    expect(fake.dialogs).toHaveLength(0);
  });

  it("turns approval back on from the list of settings", async () => {
    const { pi, settingsPath } = await enabledPi({ permission: "allow" }, false);
    const started = fakeContext();
    pi.handlers.get("session_start")?.({}, started.ctx);
    expect(started.statuses.at(-1)).toBe("permission: allow");

    const command = fakeContext({ selections: ["ask (current)", "allow"] });
    await pi.commands.get("approval")?.handler("", command.ctx);

    expect(command.notifications.at(-1)).toBe(
      "permission: ask, saved for new sessions; tool calls ask before they run"
    );
    expect(command.statuses.at(-1)).toBeUndefined();
    await expect(readSettings(settingsPath)).resolves.toEqual({ permission: "ask" });

    const fake = fakeContext({ selections: [deny] });
    expect(blockReason(await callTool(pi, fake))).toBe(
      "Tool call was blocked by the user and did not run."
    );
  });

  it("marks the current mode in the settings list", async () => {
    const { pi } = await enabledPi();
    const fake = fakeContext({ selections: ["allow"] });

    await pi.commands.get("approval")?.handler("", fake.ctx);

    expect(fake.choices[0]).toEqual(["ask (current)", "allow"]);
    expect(fake.statuses.at(-1)).toBe("permission: allow");
  });

  it("accepts on and off as aliases for ask and allow", async () => {
    const { pi, settingsPath } = await enabledPi();

    await pi.commands.get("approval")?.handler("off", fakeContext().ctx);
    await expect(readSettings(settingsPath)).resolves.toEqual({ permission: "allow" });

    await pi.commands.get("approval")?.handler("on", fakeContext().ctx);
    await expect(readSettings(settingsPath)).resolves.toEqual({ permission: "ask" });
  });

  it("reports the current mode without a terminal", async () => {
    const { pi } = await enabledPi();
    const fake = fakeContext({ hasUI: false });

    await pi.commands.get("approval")?.handler("", fake.ctx);

    expect(fake.notifications.at(-1)).toBe(
      "permission: ask; run localpi in a terminal to change it"
    );
  });

  it("completes and rejects command arguments", async () => {
    const { pi } = await enabledPi();
    const completions = pi.commands.get("approval")?.getArgumentCompletions;

    expect(completions?.("al")).toEqual([{ value: "allow", label: "allow" }]);
    expect(completions?.("off")).toEqual([{ value: "off", label: "off" }]);
    expect(completions?.("x")).toBeNull();
  });
});

async function enabledPi(
  settings: Record<string, unknown> = {},
  enabled = true,
  approveReadTools = false
): Promise<{ readonly pi: FakePi; readonly settingsPath: string }> {
  const dir = await makeTemporaryDir("localpi-approval");
  const settingsPath = path.join(dir, "settings.json");
  if (Object.keys(settings).length > 0) {
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  }
  const extension = await loadGeneratedExtension(
    approvalExtensionSource({ enabled, settingsPath, approveReadTools })
  );
  const pi = fakePi();
  extension(pi);
  return { pi, settingsPath };
}

async function readSettings(settingsPath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function callTool(pi: FakePi, fake: FakeContext): unknown {
  return callToolNamed(pi, fake, "bash");
}

function callToolNamed(pi: FakePi, fake: FakeContext, toolName: string): unknown {
  return pi.handlers.get("tool_call")?.({ toolName, input: { command: "ls" } }, fake.ctx);
}

function blockReason(result: unknown): string {
  const record = result as { readonly block?: boolean; readonly reason?: string } | undefined;
  expect(record?.block).toBe(true);
  return record?.reason ?? "";
}

function terminates(result: unknown): boolean {
  const record = result as { readonly terminate?: boolean } | undefined;
  return record?.terminate === true;
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
    readonly selections?: readonly (string | undefined)[];
  } = {}
): FakeContext {
  const dialogs: string[] = [];
  const statuses: (string | undefined)[] = [];
  const notifications: string[] = [];
  const choices: string[][] = [];
  const pending = [...(options.selections ?? [])];
  const ctx = {
    hasUI: options.hasUI ?? true,
    ui: {
      setStatus: (_key: string, text: string | undefined) => {
        statuses.push(text);
      },
      notify: (message: string) => {
        notifications.push(message);
      },
      select: (title: string, names: string[]) => {
        dialogs.push(title);
        choices.push(names);
        return Promise.resolve(pending.shift());
      }
    }
  };
  return { ctx, dialogs, statuses, notifications, choices };
}
