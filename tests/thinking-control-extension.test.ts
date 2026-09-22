import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { thinkingControlExtensionSource } from "../src/pi/extension-sources/thinking-control.js";
import {
  cleanupTemporaryDirs,
  loadGeneratedExtension,
  makeTemporaryDir
} from "./support/extension-harness.js";

type Handler = (event: unknown) => unknown;

type FakePi = {
  readonly handlers: Map<string, Handler>;
  readonly commands: string[];
  readonly on: (event: string, handler: Handler) => void;
  readonly registerCommand: (name: string, command: unknown) => void;
  readonly getThinkingLevel: () => string;
};

afterEach(async () => {
  await cleanupTemporaryDirs();
});

describe("generated localpi thinking control extension", () => {
  it("remembers the level Pi selected", async () => {
    const { pi, settingsPath } = await startPi("off");

    await pi.handlers.get("thinking_level_select")?.({ level: "low" });

    expect(await settings(settingsPath)).toEqual({ thinking: "low" });
  });

  it("remembers the level when the session ends", async () => {
    const { pi, settingsPath } = await startPi("high");

    await pi.handlers.get("session_shutdown")?.({ reason: "quit" });

    expect(await settings(settingsPath)).toEqual({ thinking: "high" });
  });

  it("saves the reported level without rewriting it", async () => {
    const { pi, settingsPath } = await startPi("off");

    await pi.handlers.get("thinking_level_select")?.({ level: "max" });

    expect(await settings(settingsPath)).toEqual({ thinking: "max" });
  });

  it("keeps other remembered settings", async () => {
    const { pi, settingsPath } = await startPi("off");
    await writeFile(settingsPath, `${JSON.stringify({ stats: "line" })}\n`, "utf8");

    await pi.handlers.get("thinking_level_select")?.({ level: "medium" });

    expect(await settings(settingsPath)).toEqual({ stats: "line", thinking: "medium" });
  });

  it("registers no slash command, because Pi owns /thinking", async () => {
    const { pi } = await startPi("off");

    expect(pi.commands).toEqual([]);
  });
});

async function startPi(level: string): Promise<{
  readonly pi: FakePi;
  readonly settingsPath: string;
}> {
  const stateDir = await makeTemporaryDir("localpi-thinking-");
  const settingsPath = path.join(stateDir, "settings.json");
  const extension = await loadGeneratedExtension(thinkingControlExtensionSource(settingsPath));
  const pi = fakePi(level);
  extension(pi);
  return { pi, settingsPath };
}

function fakePi(level: string): FakePi {
  return {
    handlers: new Map<string, Handler>(),
    commands: [],
    on(event, handler) {
      this.handlers.set(event, handler);
    },
    registerCommand(name) {
      this.commands.push(name);
    },
    getThinkingLevel() {
      return level;
    }
  };
}

async function settings(settingsPath: string): Promise<unknown> {
  return JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
}
