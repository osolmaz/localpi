import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { LocalpiOptions } from "../src/localpi/options.js";
import { writeDefaultExtensions } from "../src/pi/extensions.js";

describe("Pi extensions", () => {
  it("writes thinking control, approval, token status, and status line extensions", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-ext-"));
    try {
      const bundle = await writeDefaultExtensions(options(stateDir), {
        engines: [{ provider: "llama-cpp", engine: "llama.cpp" }]
      });
      expect(bundle.paths).toHaveLength(5);
      expect(bundle.systemPrompt).toContain("may require user approval");
      const thinking = await readFile(bundle.paths[0] ?? "", "utf8");
      const approval = await readFile(bundle.paths[1] ?? "", "utf8");
      const status = await readFile(bundle.paths[2] ?? "", "utf8");
      const line = await readFile(bundle.paths[3] ?? "", "utf8");
      expect(thinking).toContain(JSON.stringify(path.join(stateDir, "settings.json")));
      expect(thinking).toContain("persistThinking(pi.getThinkingLevel())");
      expect(thinking).toContain("persistThinking(event.level)");
      expect(thinking).toContain("thinking_level_select");
      expect(thinking).not.toContain("registerCommand");
      expect(thinking).not.toContain("setThinkingLevel");
      expect(approval).toContain("ctx.ui.select");
      expect(approval).toContain('pi.registerCommand("approval"');
      expect(approval).toContain("const initialEnabled: boolean = true;");
      expect(bundle.systemPrompt).toContain("Tool approval rule:");
      expect(approval).not.toContain("before_agent_start");
      expect(approval).toContain("Allow all tools for this session");
      expect(approval).toContain(
        'const readOnlyTools: readonly string[] = ["read", "grep", "find", "ls"]'
      );
      expect(approval).toContain("const gateReadTools: boolean = false;");
      expect(approval).toContain('settings["permission"] = mode');
      expect(approval).toContain(JSON.stringify(path.join(stateDir, "settings.json")));
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
      expect(status).not.toContain("setStatus");
      expect(line).toContain('pi.on("session_start"');
      expect(line).toContain("ctx.ui.setFooter");
      expect(line).toContain("getExtensionStatuses");
      expect(line).toContain('[{"provider":"llama-cpp","engine":"llama.cpp"}]');
      expect(line).not.toContain("setStatus(");
      expect(line).not.toContain("appendEntry");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("writes the status line extension only when the stats display is on", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-ext-"));
    try {
      const engines = [{ provider: "llama-cpp", engine: "llama.cpp" }];

      const line = await writeDefaultExtensions(
        { ...options(stateDir), stats: "line" },
        { engines }
      );
      expect(line.paths.map((entry) => path.basename(entry))).toContain("status-line.ts");

      const off = await writeDefaultExtensions({ ...options(stateDir), stats: "off" }, { engines });
      expect(off.paths.map((entry) => path.basename(entry))).not.toContain("status-line.ts");
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
      expect(bundle.paths).toHaveLength(3);
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

  it("uses the same extension for manual stop and generic truncation", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-ext-"));
    try {
      const off = await writeDefaultExtensions(options(stateDir));
      expect(off.paths).toHaveLength(5);
      const on = await writeDefaultExtensions({ ...options(stateDir), continueOnTruncation: 2 });
      expect(on.paths).toHaveLength(5);
      const stop = await readFile(
        on.paths.find((entry) => path.basename(entry) === "stop-thinking.ts") ?? "",
        "utf8"
      );
      expect(stop).toContain("const continuationLimit: number = 2;");
      expect(stop).toContain('pi.on("turn_end"');
      expect(stop).toContain('pi.sendUserMessage(nudge, { deliverAs: "followUp" })');
      expect(stop).not.toContain("process.env");
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

  it("loads the packaged pi-demo-mode extension and env when demo mode is enabled", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-ext-"));
    try {
      const bundle = await writeDefaultExtensions({
        ...options(stateDir),
        demo: true,
        demoInitialPrompt: "- start story",
        demoFollowupPrompt: "@keep going"
      });
      expect(bundle.paths).toHaveLength(6);
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

  it("bakes the stop thinking key and button delay into the extension", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-ext-"));
    try {
      const bundle = await writeDefaultExtensions(
        { ...options(stateDir), stopThinkingDelay: 2.5 },
        { engines: [{ provider: "llama-cpp", engine: "llama.cpp" }] }
      );
      const stop = await readFile(
        bundle.paths.find((entry) => path.basename(entry) === "stop-thinking.ts") ?? "",
        "utf8"
      );
      expect(stop).toContain("const buttonDelayMs: number = 2500;");
      expect(stop).toContain('const shortcut: ShortcutKey | undefined = "ctrl+shift+s";');
      expect(stop).toContain('const nativeProviders = new Set<string>(["llama-cpp"]);');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("requires a selected supported engine for an opt-in endpoint cap", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-ext-"));
    try {
      const engines = [
        { provider: "llama-cpp", engine: "llama.cpp" },
        { provider: "vllm", engine: "vLLM" },
        { provider: "llama-server", engine: "llama-server" }
      ];
      const capped = { ...options(stateDir), thinkingPhaseOutputCap: 8000 };
      const bundle = await writeDefaultExtensions(capped, {
        engines,
        runtime: { providerId: "vllm", baseUrl: "https://example.test/v1", model: "model" }
      });
      const stop = await readFile(
        bundle.paths.find((entry) => path.basename(entry) === "stop-thinking.ts") ?? "",
        "utf8"
      );
      expect(stop).toContain("const thinkingPhaseOutputCap: number | undefined = 8000;");
      expect(stop).toContain('["llama-cpp","vllm"]');
      await expect(
        writeDefaultExtensions(capped, {
          engines,
          runtime: {
            providerId: "llama-server",
            baseUrl: "http://127.0.0.1:18194/v1",
            model: "model"
          }
        })
      ).rejects.toThrow("needs a selected llama.cpp or vLLM provider");
      const managed = await writeDefaultExtensions(
        { ...options(stateDir), thinkingBudget: 8000 },
        {
          engines,
          runtime: {
            providerId: "llama-server",
            baseUrl: "http://127.0.0.1:18194/v1",
            model: "model"
          }
        }
      );
      expect(await readFile(managed.paths[4] ?? "", "utf8")).toContain(
        "const thinkingPhaseOutputCap: number | undefined = undefined;"
      );
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
      expect(bundle.paths).toHaveLength(6);
      const selector = await readFile(bundle.paths[0] ?? "", "utf8");
      expect(selector).toContain("ModelSelectorComponent");
      expect(selector).toContain('pi.on("session_start"');
      expect(selector).toContain("ctx.ui.custom");
      expect(selector).toContain("pi.setModel(selected)");
      expect(selector).toContain('"provider":"lmstudio","id":"gemma"');
      expect(selector).toContain("startupModelRuntime(ctx.modelRegistry)");
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
    apiKey: "local",
    model: "gemma-12b",
    provider: undefined,
    customProviderId: "local-openai",
    providersFile: undefined,
    modelProfileFile: undefined,
    modelReasoning: undefined,
    modelThinkingFormat: undefined,
    stateDir,
    sessionDir: path.join(stateDir, "sessions"),
    piCommand: ["pi"],
    thinking: "off",
    thinkingBudget: undefined,
    thinkingBudgetMessage: undefined,
    thinkingPhaseOutputCap: undefined,
    contextWindow: undefined,
    maxTokens: 8192,
    continueOnTruncation: 0,
    timeoutMs: 1000,
    serverCommand: "llama-server",
    host: "127.0.0.1",
    port: 18194,
    gpuLayers: 999,
    parallel: 1,
    chatTemplate: undefined,
    tools: "read,bash,edit,write,grep,find,ls",
    approval: true,
    approveReadTools: false,
    stats: "full",
    skills: "own",
    tuiMode: "fullscreen",
    stopThinkingKey: "ctrl+shift+s",
    stopThinkingDelay: 5,
    demo: false,
    demoFromCli: false,
    demoInitialPrompt: undefined,
    demoInitialPromptFile: undefined,
    demoFollowupPrompt: undefined,
    demoFollowupPromptFile: undefined,
    acp: false,
    acpFromCli: false,
    web: false,
    webPort: 0,
    webOpen: true,
    webHost: "127.0.0.1",
    webAllowedHosts: [],
    webTheme: "latte",
    status: false,
    stop: false,
    list: false,
    forwardedArgs: []
  };
}
