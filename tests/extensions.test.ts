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
      const bundle = await writeDefaultExtensions(options(stateDir), {
        engines: [{ provider: "llama-cpp", engine: "llama.cpp" }]
      });
      expect(bundle.paths).toHaveLength(3);
      expect(bundle.systemPrompt).toContain("may require user approval");
      const thinking = await readFile(bundle.paths[0] ?? "", "utf8");
      const approval = await readFile(bundle.paths[1] ?? "", "utf8");
      const status = await readFile(bundle.paths[2] ?? "", "utf8");
      expect(thinking).toContain(JSON.stringify(path.join(stateDir, "settings.json")));
      expect(thinking).toContain("persistThinking(pi.getThinkingLevel())");
      expect(thinking).toContain("persistThinking(event.level)");
      expect(thinking).toContain("thinking_level_select");
      expect(thinking).not.toContain("registerCommand");
      expect(thinking).not.toContain("setThinkingLevel");
      expect(approval).toContain("ctx.ui.confirm");
      expect(approval).toContain('pi.registerCommand("approval"');
      expect(approval).toContain("const initialEnabled: boolean = true;");
      expect(approval).toContain("Tool approval rule:");
      expect(status).toContain("tok/s");
      expect(status).toContain('pi.on("turn_start"');
      expect(status).toContain('pi.on("message_update"');
      expect(status).toContain('pi.on("turn_end"');
      expect(status).toContain("ctx.ui.setWorkingMessage");
      expect(status).toContain("registerEntryRenderer");
      expect(status).toContain("pi.appendEntry(entryType, data)");
      expect(status).toContain('pi.registerCommand("stats"');
      expect(status).toContain("n_prompt_tokens_processed");
      expect(status).toContain("formatTokenCount");
      expect(status).toContain(JSON.stringify(path.join(stateDir, "settings.json")));
      expect(status).not.toContain("slots?model=");
      expect(status).not.toContain("turns.get(event.turnIndex)");
      expect(status).toContain('[{"provider":"llama-cpp","engine":"llama.cpp"}]');
      expect(status).not.toContain("setStatus");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("writes no extra footer status extension", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-ext-"));
    try {
      const engines = [{ provider: "llama-cpp", engine: "llama.cpp" }];

      const line = await writeDefaultExtensions(
        { ...options(stateDir), stats: "line" },
        { engines }
      );
      expect(line.paths.map((entry) => path.basename(entry))).not.toContain("engine-status.ts");

      const full = await writeDefaultExtensions(options(stateDir), { engines });
      expect(full.paths.map((entry) => path.basename(entry))).not.toContain("engine-status.ts");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("starts with approval off and keeps remembering thinking when optional extensions are off", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-ext-"));
    try {
      const bundle = await writeDefaultExtensions({
        ...options(stateDir),
        approval: false,
        stats: "off"
      });
      expect(bundle.paths).toHaveLength(2);
      const thinking = await readFile(bundle.paths[0] ?? "", "utf8");
      expect(thinking).toContain("thinking_level_select");
      const approval = await readFile(bundle.paths[1] ?? "", "utf8");
      expect(approval).toContain("const initialEnabled: boolean = false;");
      expect(approval).toContain('pi.registerCommand("approval"');
      expect(bundle.systemPrompt).toContain("may require user approval");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("adds llama.cpp prefill polling only for llama.cpp runtimes", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-ext-"));
    try {
      const llama = await writeDefaultExtensions(options(stateDir), {
        runtime: {
          providerId: "llama-cpp",
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "local-model"
        }
      });
      const llamaStatus = await readFile(llama.paths[2] ?? "", "utf8");
      expect(llamaStatus).toContain("http://127.0.0.1:8080/slots?model=local-model");

      const managed = await writeDefaultExtensions(options(stateDir), {
        runtime: {
          providerId: "llama-server",
          baseUrl: "http://127.0.0.1:18194/v1",
          model: "local-model"
        }
      });
      expect(await readFile(managed.paths[2] ?? "", "utf8")).toContain(
        "http://127.0.0.1:18194/slots?model=local-model"
      );

      const vllm = await writeDefaultExtensions(options(stateDir), {
        runtime: {
          providerId: "vllm",
          baseUrl: "http://127.0.0.1:8000/v1",
          model: "qwen"
        }
      });
      expect(await readFile(vllm.paths[2] ?? "", "utf8")).not.toContain("slots?model=");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("writes a TUI demo extension when demo mode is enabled", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-ext-"));
    try {
      const bundle = await writeDefaultExtensions({
        ...options(stateDir),
        demo: true,
        demoInitialPrompt: "- start story",
        demoFollowupPrompt: "@keep going"
      });
      expect(bundle.paths).toHaveLength(4);
      expect(path.basename(bundle.paths[0] ?? "")).toBe("demo-mode.ts");
      const demo = await readFile(bundle.paths[0] ?? "", "utf8");
      expect(demo).toContain('pi.on("session_start"');
      expect(demo).toContain('event.reason !== "startup"');
      expect(demo).toContain('ctx.mode !== "tui"');
      expect(demo).toContain('pi.on("turn_end"');
      expect(demo).toContain('event.message.role !== "assistant"');
      expect(demo).toContain("switch (event.message.stopReason)");
      expect(demo).toContain('case "aborted"');
      expect(demo).toContain('case "error"');
      expect(demo).toContain('case "toolUse"');
      expect(demo).toContain("stopped = true");
      expect(demo).toContain("pi.sendUserMessage(initialPrompt)");
      expect(demo).toContain('pi.sendUserMessage(followupPrompt, { deliverAs: "followUp" })');
      expect(demo).toContain('const initialPrompt = "- start story";');
      expect(demo).toContain('const followupPrompt = "@keep going";');
      expect(demo).not.toContain("-p");
      expect(demo).not.toContain("--prompt");
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
      expect(thinking).toContain("thinking_level_select");
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
    stats: "full",
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
