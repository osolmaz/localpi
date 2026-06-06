import path from "node:path";

import { describe, expect, it } from "vitest";

import type { LocalpiOptions } from "../src/localpi/options.js";
import type { RuntimeConnection } from "../src/localpi/runtime.js";
import type { RuntimeConfig } from "../src/pi/config.js";
import { createLaunchPlan } from "../src/pi/launch.js";

describe("Pi launch plan", () => {
  it("adds localpi extensions, system prompt, and default tools", async () => {
    const plan = await createLaunchPlan(
      options("/tmp/localpi-state"),
      runtimeConfig("/tmp/localpi-state"),
      connection("gemma-4-e4b-it"),
      {
        paths: ["/tmp/localpi-state/pi-extensions/tool-approval.ts"],
        systemPrompt: "localpi prompt"
      }
    );

    expect(plan.args).toEqual([
      "--provider",
      "local-openai",
      "--model",
      "gemma-4-e4b-it",
      "--thinking",
      "off",
      "--extension",
      "/tmp/localpi-state/pi-extensions/tool-approval.ts",
      "--append-system-prompt",
      "localpi prompt",
      "--tools",
      "read,bash,edit,write,grep,find,ls",
      "-p",
      "say ok"
    ]);
  });

  it("does not add default tools when the user passes an explicit tool flag", async () => {
    const plan = await createLaunchPlan(
      { ...options("/tmp/localpi-state"), forwardedArgs: ["--tools", "bash", "-p", "say ok"] },
      runtimeConfig("/tmp/localpi-state"),
      connection("gemma-4-e4b-it"),
      { paths: [], systemPrompt: "localpi prompt" }
    );

    expect(plan.args).toContain("--tools");
    expect(plan.args.filter((arg) => arg === "--tools")).toHaveLength(1);
    expect(plan.args).toContain("bash");
  });
});

function options(stateDir: string): LocalpiOptions {
  return {
    runtime: "lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "auto",
    providerId: "local-openai",
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
    status: false,
    stop: false,
    list: false,
    forwardedArgs: ["-p", "say ok"]
  };
}

function connection(model: string): RuntimeConnection {
  return {
    runtime: "lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    model,
    availableModels: [model],
    warnings: []
  };
}

function runtimeConfig(stateDir: string): RuntimeConfig {
  return {
    configDir: path.join(stateDir, "pi"),
    modelsPath: path.join(stateDir, "pi", "models.json"),
    settingsPath: path.join(stateDir, "pi", "settings.json")
  };
}
