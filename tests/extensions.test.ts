import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { LocalpiOptions } from "../src/localpi/options.js";
import { writeDefaultExtensions } from "../src/pi/extensions.js";

describe("Pi extensions", () => {
  it("writes thinking control, approval, and token status extensions", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-ext-"));
    try {
      const bundle = await writeDefaultExtensions(options(stateDir));
      expect(bundle.paths).toHaveLength(3);
      expect(bundle.systemPrompt).toContain("Tool calls require user approval");
      const thinking = await readFile(bundle.paths[0] ?? "", "utf8");
      const approval = await readFile(bundle.paths[1] ?? "", "utf8");
      const status = await readFile(bundle.paths[2] ?? "", "utf8");
      expect(thinking).toContain('pi.registerCommand("thinking"');
      expect(thinking).toContain("pi.setThinkingLevel(level)");
      expect(thinking).toContain(JSON.stringify(path.join(stateDir, "settings.json")));
      expect(thinking).toContain("persistThinking(actual)");
      expect(thinking).toContain("persistThinking(event.level)");
      expect(thinking).toContain("thinking_level_select");
      expect(approval).toContain("ctx.ui.confirm");
      expect(status).toContain("tok/s");
      expect(status).toContain("message_update");
      expect(status).toContain("currentTurn");
      expect(status).toContain("firstOutputAt");
      expect(status).toContain("generationElapsed");
      expect(status).toContain("prefillTokenCount");
      expect(status).toContain("input + cacheWrite");
      expect(status).toContain("prefill ");
      expect(status).toContain("gen ");
      expect(status).toContain("outputText += update.text");
      expect(status).toContain('kind: "delta"');
      expect(status).not.toContain("turns.get(event.turnIndex)");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps thinking control and reports disabled approval when optional extensions are off", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-ext-"));
    try {
      const bundle = await writeDefaultExtensions({
        ...options(stateDir),
        approval: false,
        tokenStatus: false
      });
      expect(bundle.paths).toHaveLength(1);
      const thinking = await readFile(bundle.paths[0] ?? "", "utf8");
      expect(thinking).toContain('pi.registerCommand("thinking"');
      expect(bundle.systemPrompt).toContain("Tool approval is disabled for this session.");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("loads the packaged pi-demo-mode extension and env when demo mode is enabled", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-ext-"));
    try {
      const bundle = await writeDefaultExtensions({
        ...options(stateDir),
        demo: true,
        demoInitialPrompt: "- start story",
        demoFollowupPrompt: "@keep going"
      });
      expect(bundle.paths).toHaveLength(4);
      const demoPath = bundle.paths[0] ?? "";
      expect(demoPath).toContain(path.join("pi-demo-mode", "extensions", "demo-mode.ts"));
      const demo = await readFile(demoPath, "utf8");
      expect(demo).toContain('process.env["PI_DEMO_MODE"] === "1"');
      expect(demo).toContain('pi.on("session_start"');
      expect(demo).toContain('pi.on("turn_end"');
      expect(bundle.env).toEqual({
        PI_DEMO_MODE: "1",
        PI_DEMO_INITIAL_PROMPT: "- start story",
        PI_DEMO_FOLLOWUP_PROMPT: "@keep going"
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes no extension env outside demo mode", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-ext-"));
    try {
      const bundle = await writeDefaultExtensions(options(stateDir));
      expect(bundle.env).toEqual({});
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("writes a Pi-native startup model selector extension when requested", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-ext-"));
    try {
      const bundle = await writeDefaultExtensions(options(stateDir), {
        startupModelSelector: {
          models: [
            { provider: "lmstudio", id: "gemma" },
            { provider: "vllm", id: "qwen" }
          ]
        }
      });
      expect(bundle.paths).toHaveLength(4);
      const selector = await readFile(bundle.paths[0] ?? "", "utf8");
      expect(selector).toContain("ModelSelectorComponent");
      expect(selector).toContain('pi.on("session_start"');
      expect(selector).toContain("ctx.ui.custom");
      expect(selector).toContain("pi.setModel(selected)");
      expect(selector).toContain('"provider":"lmstudio","id":"gemma"');
      expect(selector).toContain("startupModelRegistry(ctx.modelRegistry)");
      expect(selector).not.toContain("readline");
      const thinking = await readFile(bundle.paths[1] ?? "", "utf8");
      expect(thinking).toContain('pi.registerCommand("thinking"');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("scopes the Pi-native startup selector when a provider scope is requested", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-ext-"));
    try {
      const bundle = await writeDefaultExtensions(options(stateDir), {
        startupModelSelector: {
          models: [
            { provider: "lmstudio", id: "first" },
            { provider: "lmstudio", id: "second" }
          ]
        }
      });
      const selector = await readFile(bundle.paths[0] ?? "", "utf8");
      expect(selector).toContain('"provider":"lmstudio","id":"first"');
      expect(selector).toContain("startupModelKeys.has(modelKey(model))");
      expect(selector).toContain("selectableModels.map((model) => ({ model }))");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

function options(stateDir: string): LocalpiOptions {
  return {
    runtime: "llama-server",
    baseUrl: undefined,
    model: "gemma-12b",
    provider: undefined,
    customProviderId: "local-openai",
    providersFile: undefined,
    modelProfileFile: undefined,
    modelReasoning: undefined,
    modelThinkingFormat: undefined,
    stateDir,
    sessionDir: path.join(stateDir, "sessions"),
    piCommand: "pi",
    thinking: "off",
    contextWindow: undefined,
    maxTokens: 8192,
    timeoutMs: 1000,
    serverCommand: "llama-server",
    host: "127.0.0.1",
    port: 18194,
    gpuLayers: 999,
    parallel: 1,
    chatTemplate: undefined,
    tools: "read,bash,edit,write,grep,find,ls",
    approval: true,
    tokenStatus: true,
    demo: false,
    demoFromCli: false,
    demoInitialPrompt: undefined,
    demoInitialPromptFile: undefined,
    demoFollowupPrompt: undefined,
    demoFollowupPromptFile: undefined,
    status: false,
    stop: false,
    list: false,
    forwardedArgs: []
  };
}
