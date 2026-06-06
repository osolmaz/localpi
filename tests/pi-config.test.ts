import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { LocalpiOptions } from "../src/localpi/options.js";
import type { RuntimeConnection } from "../src/localpi/runtime.js";
import { writeRuntimeConfig } from "../src/pi/config.js";

describe("Pi runtime config", () => {
  it("writes a local OpenAI-compatible provider config", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-test-"));
    try {
      const runtime = await writeRuntimeConfig(
        options(stateDir),
        connection("gemma-4-e4b-it", "http://127.0.0.1:1234/v1")
      );
      const models = JSON.parse(await readFile(runtime.modelsPath, "utf8")) as {
        providers: Record<string, { baseUrl: string; models: readonly { id: string }[] }>;
      };
      expect(models.providers["local-openai"]?.baseUrl).toBe("http://127.0.0.1:1234/v1");
      expect(models.providers["local-openai"]?.models[0]?.id).toBe("gemma-4-e4b-it");
      expect(models.providers["local-openai"]?.models[0]).not.toHaveProperty("contextWindow");
      const settings = JSON.parse(await readFile(runtime.settingsPath, "utf8")) as {
        compaction?: { enabled?: boolean };
      };
      expect(settings.compaction?.enabled).toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("writes context window only from an override or discovered metadata", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-test-"));
    try {
      const runtime = await writeRuntimeConfig(
        options(stateDir),
        connection("gemma-4-e4b-it", "http://127.0.0.1:1234/v1", 120000)
      );
      const models = JSON.parse(await readFile(runtime.modelsPath, "utf8")) as {
        providers: Record<string, { models: readonly { contextWindow?: number }[] }>;
      };
      expect(models.providers["local-openai"]?.models[0]?.contextWindow).toBe(120000);
      const settings = JSON.parse(await readFile(runtime.settingsPath, "utf8")) as {
        compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
      };
      expect(settings.compaction).toEqual({
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 20000
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("scales Pi compaction settings below small local context windows", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-test-"));
    try {
      const runtime = await writeRuntimeConfig(
        { ...options(stateDir), contextWindow: 4096 },
        connection("gemma-4-e4b-it", "http://127.0.0.1:1234/v1")
      );
      const settings = JSON.parse(await readFile(runtime.settingsPath, "utf8")) as {
        compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
      };
      expect(settings.compaction).toEqual({
        enabled: true,
        reserveTokens: 1024,
        keepRecentTokens: 2048
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
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
    forwardedArgs: []
  };
}

function connection(model: string, baseUrl: string, contextWindow?: number): RuntimeConnection {
  return {
    runtime: "lmstudio",
    baseUrl,
    model,
    availableModels: [model],
    ...(contextWindow === undefined ? {} : { contextWindow }),
    warnings: []
  };
}
