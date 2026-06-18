import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { CatalogModel } from "../src/localpi/catalog.js";
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
      expect(models.providers["lmstudio"]?.baseUrl).toBe("http://127.0.0.1:1234/v1");
      expect(models.providers["lmstudio"]?.models[0]?.id).toBe("gemma-4-e4b-it");
      expect(models.providers["lmstudio"]?.models[0]).not.toHaveProperty("contextWindow");
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
      expect(models.providers["lmstudio"]?.models[0]?.contextWindow).toBe(120000);
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

  it("writes every loaded catalog provider for Pi model switching", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-test-"));
    try {
      const runtime = await writeRuntimeConfig(
        { ...options(stateDir), contextWindow: 4096 },
        {
          runtime: "vllm",
          providerId: "vllm",
          providerName: "vLLM",
          baseUrl: "http://127.0.0.1:8000/v1",
          model: "qwen",
          availableModels: ["qwen"],
          catalogModels: [
            catalogModel("lmstudio", "LM Studio", "http://127.0.0.1:1234/v1", "gemma", 120000),
            catalogModel(
              "vllm",
              "vLLM",
              "http://127.0.0.1:8000/v1",
              "qwen",
              32768,
              true,
              "qwen-chat-template"
            )
          ],
          warnings: []
        }
      );
      const models = JSON.parse(await readFile(runtime.modelsPath, "utf8")) as {
        providers: Record<
          string,
          {
            baseUrl: string;
            models: readonly {
              id: string;
              contextWindow?: number;
              reasoning?: boolean;
              compat?: { thinkingFormat?: string };
            }[];
          }
        >;
      };
      const lmstudio = models.providers["lmstudio"] as {
        readonly models: readonly {
          readonly id: string;
          readonly contextWindow?: number;
          readonly reasoning?: boolean;
          readonly compat?: { readonly thinkingFormat?: string };
        }[];
      };
      const vllm = models.providers["vllm"] as {
        readonly models: readonly {
          readonly id: string;
          readonly contextWindow?: number;
          readonly reasoning?: boolean;
          readonly compat?: { readonly thinkingFormat?: string };
        }[];
      };
      expect(Object.keys(models.providers).sort()).toEqual(["lmstudio", "vllm"]);
      expect(lmstudio.models[0]).toMatchObject({
        id: "gemma",
        reasoning: true,
        contextWindow: 4096
      });
      expect(vllm.models[0]).toMatchObject({
        id: "qwen",
        reasoning: true,
        contextWindow: 4096,
        compat: { thinkingFormat: "qwen-chat-template" }
      });
      const settings = JSON.parse(await readFile(runtime.settingsPath, "utf8")) as {
        defaultProvider?: string;
        defaultModel?: string;
      };
      expect(settings.defaultProvider).toBe("vllm");
      expect(settings.defaultModel).toBe("qwen");
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

function catalogModel(
  providerId: string,
  providerName: string,
  baseUrl: string,
  modelId: string,
  contextWindow?: number,
  reasoning = true,
  thinkingFormat?: CatalogModel["thinkingFormat"]
): CatalogModel {
  return {
    providerId,
    providerName,
    runtime: "openai-compatible",
    baseUrl,
    modelId,
    aliases: [],
    displayName: `${providerName} / ${modelId}`,
    maxTokens: 8192,
    reasoning,
    ...(thinkingFormat === undefined ? {} : { thinkingFormat }),
    capabilities: ["text"],
    availability: "loaded",
    ...(contextWindow === undefined ? {} : { contextWindow })
  };
}

function connection(model: string, baseUrl: string, contextWindow?: number): RuntimeConnection {
  return {
    runtime: "lmstudio",
    providerId: "lmstudio",
    providerName: "LM Studio",
    baseUrl,
    model,
    availableModels: [model],
    catalogModels: [],
    ...(contextWindow === undefined ? {} : { contextWindow }),
    warnings: []
  };
}
