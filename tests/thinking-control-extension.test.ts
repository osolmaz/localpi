import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { thinkingControlExtensionSource } from "../src/pi/extension-sources/thinking-control.js";
import {
  cleanupTemporaryDirs,
  loadGeneratedExtension,
  makeTemporaryDir
} from "./support/extension-harness.js";

type Model = { readonly provider: string; readonly id: string; readonly reasoning?: boolean };
type Context = { readonly model: Model | undefined };
type Handler = (event: unknown, ctx: Context) => unknown;

type FakePi = {
  readonly handlers: Map<string, Handler>;
  readonly commands: string[];
  readonly on: (event: string, handler: Handler) => void;
  readonly registerCommand: (name: string, command: unknown) => void;
};

const thinker: Model = { provider: "llama-cpp", id: "thinker", reasoning: true };
const otherThinker: Model = { provider: "llama-cpp", id: "other-thinker", reasoning: true };
const plain: Model = { provider: "llama-cpp", id: "plain" };

afterEach(async () => {
  await cleanupTemporaryDirs();
});

describe("generated localpi thinking control extension", () => {
  it("remembers a level the user chose", async () => {
    const { select, settingsPath } = await startPi(thinker);

    await select("low", thinker);

    expect(await settings(settingsPath)).toEqual({ thinking: "low" });
  });

  it("does not remember the off that Pi forces for a model that cannot think", async () => {
    const { select, settingsPath } = await startPi(plain);

    await select("off", plain);

    expect(await savedSettings(settingsPath)).toBeUndefined();
  });

  it("does not remember the level Pi adjusts when the model changes", async () => {
    const { pi, select, settingsPath } = await startPi(thinker);

    await select("high", otherThinker);
    await pi.handlers.get("model_select")?.({ model: otherThinker }, { model: otherThinker });
    expect(await savedSettings(settingsPath)).toBeUndefined();

    await select("minimal", otherThinker);
    expect(await settings(settingsPath)).toEqual({ thinking: "minimal" });
  });

  it("remembers a choice after a model change that kept the level", async () => {
    const { pi, select, settingsPath } = await startPi(thinker);

    await pi.handlers.get("model_select")?.({ model: otherThinker }, { model: otherThinker });
    await select("xhigh", otherThinker);

    expect(await settings(settingsPath)).toEqual({ thinking: "xhigh" });
  });

  it("does not save when the session ends", async () => {
    const { pi, settingsPath } = await startPi(thinker);

    expect(pi.handlers.has("session_shutdown")).toBe(false);
    expect(await savedSettings(settingsPath)).toBeUndefined();
  });

  it("keeps other remembered settings", async () => {
    const { select, settingsPath } = await startPi(thinker);
    await writeFile(settingsPath, `${JSON.stringify({ stats: "line" })}\n`, "utf8");

    await select("medium", thinker);

    expect(await settings(settingsPath)).toEqual({ stats: "line", thinking: "medium" });
  });

  it("registers no slash command, because Pi owns /thinking", async () => {
    const { pi } = await startPi(thinker);

    expect(pi.commands).toEqual([]);
  });
});

async function startPi(model: Model): Promise<{
  readonly pi: FakePi;
  readonly select: (level: string, model: Model) => Promise<unknown>;
  readonly settingsPath: string;
}> {
  const stateDir = await makeTemporaryDir("localpi-thinking-");
  const settingsPath = path.join(stateDir, "settings.json");
  const extension = await loadGeneratedExtension(thinkingControlExtensionSource(settingsPath));
  const pi = fakePi();
  extension(pi);
  await pi.handlers.get("session_start")?.({ reason: "startup" }, { model });
  const select = async (level: string, current: Model): Promise<unknown> =>
    await pi.handlers.get("thinking_level_select")?.({ level }, { model: current });
  return { pi, select, settingsPath };
}

function fakePi(): FakePi {
  return {
    handlers: new Map<string, Handler>(),
    commands: [],
    on(event, handler) {
      this.handlers.set(event, handler);
    },
    registerCommand(name) {
      this.commands.push(name);
    }
  };
}

async function savedSettings(settingsPath: string): Promise<unknown> {
  try {
    return await settings(settingsPath);
  } catch {
    return undefined;
  }
}

async function settings(settingsPath: string): Promise<unknown> {
  return JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
}
