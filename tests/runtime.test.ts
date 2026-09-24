import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LocalpiOptions } from "../src/localpi/options.js";
import {
  ensureLlamaServer,
  reasoningBudgetMessage,
  stopManagedLlamaServer
} from "../src/localpi/llama-server.js";
import { effectiveBaseUrl, resolveRuntime, statusOutput } from "../src/localpi/runtime.js";

describe("runtime resolution", () => {
  const servers: ReturnType<typeof createServer>[] = [];
  const children: ChildProcess[] = [];
  const tempDirs: string[] = [];
  const previousSafetyProbe = process.env["LOCALPI_LMSTUDIO_SAFETY_PROBE"];

  beforeEach(() => {
    process.env["LOCALPI_LMSTUDIO_SAFETY_PROBE"] = "0";
  });

  afterEach(async () => {
    restoreOptionalEnv("LOCALPI_LMSTUDIO_SAFETY_PROBE", previousSafetyProbe);
    for (const child of children) {
      if (child.pid !== undefined && isAlive(child.pid)) {
        child.kill("SIGKILL");
      }
    }
    children.length = 0;
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          })
      )
    );
    servers.length = 0;
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("reuses a running llama-server for auto and backend model ids", async () => {
    const baseUrl = await startModelServer("served-model");

    await expect(resolveRuntime({ ...options(), baseUrl, model: "auto" })).resolves.toMatchObject({
      runtime: "llama-server/external",
      model: "served-model"
    });
    await expect(
      resolveRuntime({ ...options(), baseUrl, model: "served-model" })
    ).resolves.toMatchObject({
      runtime: "llama-server/external",
      model: "served-model"
    });
  });

  it("stops active owned metadata before starting on a different endpoint", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const child = spawnFakeLlamaServer(modelPath);
    await writeMetadata(stateDir, {
      pid: child.pid ?? 0,
      baseUrl: "http://127.0.0.1:1/v1",
      modelId: "custom-model",
      modelPath,
      contextWindow: 4096,
      serverCommand: "llama-server",
      host: "127.0.0.1",
      port: 1
    });

    await expect(
      ensureLlamaServer(
        {
          ...options(),
          stateDir,
          baseUrl: await unusedBaseUrl(),
          serverCommand: "/definitely/missing/localpi-llama-server"
        },
        { id: "custom-model", modelPath, contextWindow: 4096 }
      )
    ).rejects.toThrow(/failed to start llama-server|LM Studio also reports loaded models/);
    await waitForDead(child.pid ?? 0);
  });

  it("stops owned wrapper processes that do not include llama-server in argv", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const child = spawnFakeOwnedProcess("wrapper-command", modelPath);
    await writeMetadata(stateDir, {
      pid: child.pid ?? 0,
      baseUrl: "http://127.0.0.1:1/v1",
      modelId: "custom-model",
      modelPath,
      contextWindow: 4096,
      serverCommand: "wrapper-command",
      host: "127.0.0.1",
      port: 1
    });

    await expect(stopManagedLlamaServer({ ...options(), stateDir })).resolves.toContain("stopped");
    await waitForDead(child.pid ?? 0);
  });

  it("does not report the managed port as an LM Studio warning", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const child = spawnFakeLlamaServer(modelPath);
    await writeMetadata(stateDir, {
      pid: child.pid ?? 0,
      baseUrl: "http://127.0.0.1:1234/v1",
      modelId: "custom-model",
      modelPath,
      contextWindow: 4096,
      serverCommand: "llama-server",
      host: "127.0.0.1",
      port: 1234
    });

    await expect(
      ensureLlamaServer(
        {
          ...options(),
          stateDir,
          port: 1234,
          serverCommand: "/definitely/missing/localpi-llama-server"
        },
        { id: "different-model", modelPath, contextWindow: 4096 }
      )
    ).rejects.toThrow(/failed to start llama-server/);
    await waitForDead(child.pid ?? 0);
  });

  it("does not reuse managed llama-server metadata with mismatched explicit context", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await startModelServer("custom-model", 32768);
    const child = spawnFakeLlamaServer(modelPath);
    await writeMetadata(stateDir, {
      pid: child.pid ?? 0,
      baseUrl,
      modelId: "custom-model",
      modelPath,
      contextWindow: 32768,
      serverCommand: "llama-server",
      host: "127.0.0.1",
      port: 1
    });

    await expect(
      ensureLlamaServer(
        {
          ...options(),
          stateDir,
          baseUrl,
          contextWindow: 131072,
          serverCommand: "/definitely/missing/localpi-llama-server"
        },
        { id: "custom-model", modelPath, contextWindow: 32768 }
      )
    ).rejects.toThrow(/failed to start llama-server|LM Studio also reports loaded models/);
    await waitForDead(child.pid ?? 0);
  });

  it("starts managed llama-server on the selected base URL and reports default context", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await unusedBaseUrl();
    const serverCommand = await fakeOpenAiLlamaServerCommand(stateDir);
    const runtime = await ensureLlamaServer(
      {
        ...options(),
        stateDir,
        baseUrl,
        serverCommand
      },
      { id: "custom-model", modelPath }
    );

    expect(runtime).toMatchObject({
      baseUrl,
      contextWindow: 32768,
      managed: true,
      model: "custom-model"
    });
    const metadata = JSON.parse(
      await readFile(path.join(stateDir, "server", "llama-server.json"), "utf8")
    ) as { readonly port?: number };
    expect(metadata.port).toBe(Number.parseInt(new URL(baseUrl).port, 10));
    await stopManagedLlamaServer({ ...options(), stateDir });
  });

  it("maps low thinking to a bounded llama-server reasoning budget", async () => {
    const { stateDir, args } = await startServerWithReasoning("low");
    expect(args).toContain("--reasoning");
    expect(args[args.indexOf("--reasoning") + 1]).toBe("on");
    expect(args).toContain("--reasoning-budget");
    expect(args[args.indexOf("--reasoning-budget") + 1]).toBe("128");
    expect(args[args.indexOf("--reasoning-budget-message") + 1]).toBe(reasoningBudgetMessage);

    const metadata = await readFakeServerMetadata(stateDir);
    expect(metadata.reasoningMode).toBe("on");
    expect(metadata.reasoningBudget).toBe(128);
    expect(metadata.reasoningMessage).toBe(reasoningBudgetMessage);
    await stopManagedLlamaServer({ ...options(), stateDir });
  });

  it("caps thinking with the budget override", async () => {
    const { stateDir, args } = await startServerWithReasoning("medium", 4096);
    expect(args[args.indexOf("--reasoning") + 1]).toBe("on");
    expect(args[args.indexOf("--reasoning-budget") + 1]).toBe("4096");
    expect(args[args.indexOf("--reasoning-budget-message") + 1]).toBe(reasoningBudgetMessage);

    const metadata = await readFakeServerMetadata(stateDir);
    expect(metadata.reasoningBudget).toBe(4096);
    expect(metadata.reasoningMessage).toBe(reasoningBudgetMessage);
    await stopManagedLlamaServer({ ...options(), stateDir });
  });

  it("leaves thinking unrestricted without a message when the budget is -1", async () => {
    const { stateDir, args } = await startServerWithReasoning("medium", -1);
    expect(args[args.indexOf("--reasoning") + 1]).toBe("on");
    expect(args[args.indexOf("--reasoning-budget") + 1]).toBe("-1");
    expect(args).not.toContain("--reasoning-budget-message");

    const metadata = await readFakeServerMetadata(stateDir);
    expect(metadata.reasoningBudget).toBe(-1);
    expect(metadata.reasoningMessage).toBeUndefined();
    await stopManagedLlamaServer({ ...options(), stateDir });
  });

  it("passes no budget and no message when thinking is off", async () => {
    const { stateDir, args } = await startServerWithReasoning("off", 4096);
    expect(args[args.indexOf("--reasoning") + 1]).toBe("off");
    expect(args).not.toContain("--reasoning-budget");
    expect(args).not.toContain("--reasoning-budget-message");
    await stopManagedLlamaServer({ ...options(), stateDir });
  });

  it("rewords the reasoning stop message with the override", async () => {
    const { stateDir, args } = await startServerWithReasoning("low", undefined, "Stop now.");
    expect(args[args.indexOf("--reasoning-budget") + 1]).toBe("128");
    expect(args[args.indexOf("--reasoning-budget-message") + 1]).toBe("Stop now.");

    const metadata = await readFakeServerMetadata(stateDir);
    expect(metadata.reasoningMessage).toBe("Stop now.");
    await stopManagedLlamaServer({ ...options(), stateDir });
  });

  it("passes no message when the message override is empty", async () => {
    const { stateDir, args } = await startServerWithReasoning("low", undefined, "");
    expect(args[args.indexOf("--reasoning-budget") + 1]).toBe("128");
    expect(args).not.toContain("--reasoning-budget-message");

    const metadata = await readFakeServerMetadata(stateDir);
    expect(metadata.reasoningMessage).toBeUndefined();
    await stopManagedLlamaServer({ ...options(), stateDir });
  });

  it("does not fast-reuse managed alias runs after startup options change", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await startModelServer("custom-model", 32768);
    const child = spawnFakeLlamaServer(modelPath);
    const modelsFile = path.join(stateDir, "models.json");
    await writeFile(
      modelsFile,
      JSON.stringify({ models: { custom: { id: "custom-model", path: modelPath } } })
    );
    await writeMetadata(stateDir, {
      pid: child.pid ?? 0,
      baseUrl,
      modelId: "custom-model",
      modelPath,
      contextWindow: 32768,
      serverCommand: "llama-server",
      host: "127.0.0.1",
      port: Number.parseInt(new URL(baseUrl).port, 10),
      gpuLayers: 999,
      parallel: 1
    });
    const previousModelsFile = process.env["LOCALPI_MODELS_FILE"];
    process.env["LOCALPI_MODELS_FILE"] = modelsFile;

    try {
      await expect(
        resolveRuntime({
          ...options(),
          stateDir,
          baseUrl,
          model: "custom",
          gpuLayers: 998,
          serverCommand: "/definitely/missing/localpi-llama-server"
        })
      ).rejects.toThrow(
        /failed to start llama-server|LM Studio also reports loaded models|external local models are already loaded/
      );
    } finally {
      restoreOptionalEnv("LOCALPI_MODELS_FILE", previousModelsFile);
    }
  });

  it("does not fast-reuse auto catalog managed selections after startup options change", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await startModelServer("custom-model", 32768);
    const externalBaseUrl = await startModelServer("qwen-vllm", 131072);
    const child = spawnFakeLlamaServer(modelPath);
    const modelsFile = path.join(stateDir, "models.json");
    await writeFile(
      modelsFile,
      JSON.stringify({
        providers: builtInProviderOverrides({
          vllm: {
            type: "openai-compatible",
            name: "vLLM",
            baseUrl: externalBaseUrl,
            discover: true
          }
        }),
        models: { custom: { id: "custom-model", path: modelPath } }
      })
    );
    await writeMetadata(stateDir, {
      pid: child.pid ?? 0,
      baseUrl,
      modelId: "custom-model",
      modelPath,
      contextWindow: 32768,
      serverCommand: "llama-server",
      host: "127.0.0.1",
      port: Number.parseInt(new URL(baseUrl).port, 10),
      gpuLayers: 999,
      parallel: 1
    });
    const previousModelsFile = process.env["LOCALPI_MODELS_FILE"];
    process.env["LOCALPI_MODELS_FILE"] = modelsFile;

    try {
      await expect(
        resolveRuntime({
          ...options(),
          runtime: "auto",
          stateDir,
          baseUrl,
          model: "custom",
          gpuLayers: 998,
          serverCommand: "/definitely/missing/localpi-llama-server"
        })
      ).rejects.toThrow("external local models are already loaded");
      await waitForDead(child.pid ?? 0);
    } finally {
      restoreOptionalEnv("LOCALPI_MODELS_FILE", previousModelsFile);
    }
  });

  it("reports missing llama-server commands as controlled startup errors", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    await expect(
      ensureLlamaServer(
        {
          ...options(),
          stateDir,
          baseUrl: await unusedBaseUrl(),
          serverCommand: "/definitely/missing/localpi-llama-server"
        },
        { id: "custom-model", modelPath, contextWindow: 4096 }
      )
    ).rejects.toThrow(/failed to start llama-server|LM Studio also reports loaded models/);
  });

  it("resolves externally managed OpenAI-compatible runtimes", async () => {
    const baseUrl = await startModelServer("served-model");

    await expect(
      resolveRuntime({ ...options(), runtime: "lmstudio", baseUrl, model: "auto" })
    ).resolves.toMatchObject({
      runtime: "lmstudio",
      baseUrl,
      model: "served-model",
      contextWindow: 4096
    });
    await expect(
      resolveRuntime({ ...options(), runtime: "openai-compatible", baseUrl, model: "served-model" })
    ).resolves.toMatchObject({ runtime: "openai-compatible", model: "served-model" });
    await expect(
      resolveRuntime({ ...options(), runtime: "openai-compatible", baseUrl: undefined })
    ).rejects.toThrow("--runtime openai-compatible requires --base-url");
  });

  it("prefers DeepSeek thinking format for DeepSeek distill Qwen model ids", async () => {
    const baseUrl = await startModelServer("DeepSeek-R1-Distill-Qwen-32B");

    await expect(
      resolveRuntime({ ...options(), runtime: "lmstudio", baseUrl, model: "auto" })
    ).resolves.toMatchObject({
      catalogModels: [
        {
          modelId: "DeepSeek-R1-Distill-Qwen-32B",
          reasoning: true,
          thinkingFormat: "deepseek"
        }
      ]
    });
  });

  it("marks Qwen3 model ids with Qwen chat-template thinking format", async () => {
    const baseUrl = await startModelServer("qwen3.6-35b-a3b-mtp");

    await expect(
      resolveRuntime({ ...options(), runtime: "lmstudio", baseUrl, model: "auto" })
    ).resolves.toMatchObject({
      catalogModels: [
        {
          modelId: "qwen3.6-35b-a3b-mtp",
          reasoning: true,
          thinkingFormat: "qwen-chat-template"
        }
      ]
    });
  });

  it("marks vLLM Gemma 4 model ids with Qwen chat-template thinking format", async () => {
    const baseUrl = await startModelServer("nvidia/Gemma-4-26B-A4B-NVFP4", 32768);

    await expect(
      resolveRuntime({ ...options(), runtime: "vllm", baseUrl, model: "auto" })
    ).resolves.toMatchObject({
      runtime: "vllm",
      model: "nvidia/Gemma-4-26B-A4B-NVFP4",
      catalogModels: [
        {
          modelId: "nvidia/Gemma-4-26B-A4B-NVFP4",
          reasoning: true,
          thinkingFormat: "qwen-chat-template",
          contextWindow: 32768
        }
      ]
    });
  });

  it("uses local model profiles for explicit OpenAI-compatible capabilities", async () => {
    const { stateDir } = await tempRuntimeState();
    const baseUrl = await startModelServer("nvidia/Gemma-4-26B-A4B-NVFP4", 999999);
    const profilePath = path.join(stateDir, "gemma-profile.json");
    await writeFile(
      profilePath,
      JSON.stringify({
        id: "gemma4-26b-a4b-nvfp4",
        model: "nvidia/Gemma-4-26B-A4B-NVFP4",
        base_url: baseUrl,
        client: {
          context_window: 32768,
          max_tokens: 4096
        },
        capabilities: {
          reasoning: true,
          thinking_format: "qwen-chat-template"
        }
      })
    );

    await expect(
      resolveRuntime({
        ...options(),
        runtime: "openai-compatible",
        baseUrl,
        model: "nvidia/Gemma-4-26B-A4B-NVFP4",
        modelProfileFile: profilePath
      })
    ).resolves.toMatchObject({
      model: "nvidia/Gemma-4-26B-A4B-NVFP4",
      contextWindow: 32768,
      catalogModels: [
        {
          modelId: "nvidia/Gemma-4-26B-A4B-NVFP4",
          reasoning: true,
          thinkingFormat: "qwen-chat-template",
          contextWindow: 32768,
          maxTokens: 4096
        }
      ]
    });

    await expect(
      resolveRuntime({
        ...options(),
        runtime: "openai-compatible",
        baseUrl,
        model: "gemma4-26b-a4b-nvfp4",
        modelProfileFile: profilePath
      })
    ).resolves.toMatchObject({
      model: "nvidia/Gemma-4-26B-A4B-NVFP4",
      contextWindow: 32768,
      catalogModels: [
        {
          modelId: "nvidia/Gemma-4-26B-A4B-NVFP4",
          aliases: ["gemma4-26b-a4b-nvfp4"],
          reasoning: true,
          thinkingFormat: "qwen-chat-template",
          contextWindow: 32768,
          maxTokens: 4096
        }
      ]
    });
  });

  it("lets a model profile decide image input against the server", async () => {
    const { stateDir } = await tempRuntimeState();
    const baseUrl = await startModelListServer([
      { id: "vision-model", architecture: { input_modalities: ["text", "image"] } },
      { id: "plain-model" }
    ]);
    const disabledPath = path.join(stateDir, "no-image-profile.json");
    const enabledPath = path.join(stateDir, "image-profile.json");
    await writeFile(
      disabledPath,
      JSON.stringify({
        id: "vision-model",
        model: "vision-model",
        capabilities: { image: false }
      })
    );
    await writeFile(
      enabledPath,
      JSON.stringify({
        id: "plain-model",
        model: "plain-model",
        capabilities: { image: true }
      })
    );

    const disabled = await resolveRuntime({
      ...options(),
      runtime: "openai-compatible",
      baseUrl,
      model: "vision-model",
      modelProfileFile: disabledPath
    });
    expect(disabled.catalogModels[0]?.capabilities).toEqual(["text"]);

    const enabled = await resolveRuntime({
      ...options(),
      runtime: "openai-compatible",
      baseUrl,
      model: "plain-model",
      modelProfileFile: enabledPath
    });
    expect(enabled.catalogModels[0]?.capabilities).toEqual(["text", "image"]);
  });

  it("rejects malformed optional string fields in local model profiles", async () => {
    const { stateDir } = await tempRuntimeState();
    const baseUrl = await startModelServer("nvidia/Gemma-4-26B-A4B-NVFP4", 32768);
    const badBaseUrlProfile = path.join(stateDir, "bad-base-url-profile.json");
    const badThinkingFormatProfile = path.join(stateDir, "bad-thinking-format-profile.json");
    const badImageProfile = path.join(stateDir, "bad-image-profile.json");
    const baseProfile = {
      id: "gemma4-26b-a4b-nvfp4",
      model: "nvidia/Gemma-4-26B-A4B-NVFP4"
    };
    await writeFile(
      badBaseUrlProfile,
      JSON.stringify({
        ...baseProfile,
        base_url: 123
      })
    );
    await writeFile(
      badThinkingFormatProfile,
      JSON.stringify({
        ...baseProfile,
        capabilities: {
          thinking_format: { name: "qwen-chat-template" }
        }
      })
    );
    await writeFile(
      badImageProfile,
      JSON.stringify({
        ...baseProfile,
        capabilities: {
          image: "yes"
        }
      })
    );

    await expect(
      resolveRuntime({
        ...options(),
        runtime: "vllm",
        baseUrl,
        model: "nvidia/Gemma-4-26B-A4B-NVFP4",
        modelProfileFile: badBaseUrlProfile
      })
    ).rejects.toThrow("model profile");
    await expect(
      resolveRuntime({
        ...options(),
        runtime: "vllm",
        baseUrl,
        model: "nvidia/Gemma-4-26B-A4B-NVFP4",
        modelProfileFile: badThinkingFormatProfile
      })
    ).rejects.toThrow("model profile");
    await expect(
      resolveRuntime({
        ...options(),
        runtime: "vllm",
        baseUrl,
        model: "nvidia/Gemma-4-26B-A4B-NVFP4",
        modelProfileFile: badImageProfile
      })
    ).rejects.toThrow("capabilities.image");
  });

  it("does not mark older Qwen and DeepSeek coder model ids as reasoning models", async () => {
    const baseUrl = await startModelListServer([
      { id: "Qwen2.5-Coder-32B" },
      { id: "DeepSeek-Coder-V2" }
    ]);
    const connection = await resolveRuntime({
      ...options(),
      runtime: "lmstudio",
      baseUrl,
      model: "Qwen2.5-Coder-32B"
    });

    for (const model of connection.catalogModels) {
      expect(model).not.toHaveProperty("reasoning");
      expect(model).not.toHaveProperty("thinkingFormat");
    }
  });

  it("uses --provider as the direct OpenAI-compatible provider id", async () => {
    const baseUrl = await startModelServer("served-model");

    await expect(
      resolveRuntime({
        ...options(),
        runtime: "openai-compatible",
        provider: "custom-provider",
        baseUrl,
        model: "served-model"
      })
    ).resolves.toMatchObject({
      runtime: "openai-compatible",
      providerId: "custom-provider",
      providerName: "custom-provider",
      model: "served-model"
    });
  });

  it("preserves explicit OpenAI-compatible models when /models is empty", async () => {
    const baseUrl = await startModelListServer([]);

    await expect(
      resolveRuntime({
        ...options(),
        runtime: "openai-compatible",
        baseUrl,
        model: "explicit-model"
      })
    ).resolves.toMatchObject({
      runtime: "openai-compatible",
      model: "explicit-model",
      availableModels: ["explicit-model"]
    });
  });

  it("does not treat external model ids with slashes as GGUF paths", async () => {
    const baseUrl = await startModelServer("other-model");

    await expect(
      resolveRuntime({ ...options(), runtime: "lmstudio", baseUrl, model: "org/model" })
    ).rejects.toThrow("model org/model is not available");
  });

  it("resolves direct vLLM runtimes as externally managed providers", async () => {
    const baseUrl = await startModelServer("qwen-vllm", 131072);

    await expect(
      resolveRuntime({ ...options(), runtime: "vllm", baseUrl, model: "auto" })
    ).resolves.toMatchObject({
      runtime: "vllm",
      providerId: "vllm",
      baseUrl,
      model: "qwen-vllm",
      contextWindow: 131072
    });
  });

  it("preserves connection errors for explicit provider runtimes", async () => {
    const baseUrl = await unusedBaseUrl();

    let message = "";
    try {
      await resolveRuntime({
        ...options(),
        runtime: "vllm",
        baseUrl,
        model: "auto",
        timeoutMs: 50
      });
    } catch (error) {
      message = String(error);
    }

    expect(message).toMatch(/fetch failed|ECONNREFUSED|connect/i);
    expect(message).not.toContain("provider  did not report usable models");
  });

  it("discovers and selects configured vLLM providers in auto runtime", async () => {
    const { stateDir } = await tempRuntimeState();
    const baseUrl = await startModelServer("qwen-vllm", 131072);
    const providersFile = path.join(stateDir, "providers.json");
    await writeFile(
      providersFile,
      JSON.stringify({
        providers: builtInProviderOverrides({
          vllm: {
            type: "openai-compatible",
            name: "vLLM",
            baseUrl,
            discover: true
          }
        })
      })
    );

    await expect(
      resolveRuntime({
        ...options(),
        runtime: "auto",
        provider: "vllm",
        model: "auto",
        providersFile
      })
    ).resolves.toMatchObject({
      runtime: "vllm",
      providerId: "vllm",
      baseUrl,
      model: "qwen-vllm",
      contextWindow: 131072
    });
  });

  it("selects the loaded llama.cpp model and skips unloaded ones", async () => {
    const { stateDir } = await tempRuntimeState();
    const baseUrl = await startModelListServer(
      [
        { id: "qwen3-27b", status: { value: "unloaded" } },
        { id: "bonsai-27b", status: { value: "loaded" }, meta: { n_ctx: 32768 } }
      ],
      { role: "router", models_autoload: false }
    );
    const providersFile = await llamaCppProvidersFile(stateDir, baseUrl);

    await expect(
      resolveRuntime({ ...options(), runtime: "auto", model: "auto", providersFile })
    ).resolves.toMatchObject({
      runtime: "llama-cpp",
      providerId: "llama-cpp",
      baseUrl,
      model: "bonsai-27b",
      contextWindow: 32768,
      availableModels: ["bonsai-27b"]
    });
  });

  it("marks a llama.cpp model that accepts images as an image model", async () => {
    const { stateDir } = await tempRuntimeState();
    const baseUrl = await startModelListServer(
      [
        {
          id: "bonsai-27b",
          status: { value: "loaded" },
          architecture: { input_modalities: ["text", "image"] }
        },
        { id: "text-only-27b", status: { value: "loaded" } }
      ],
      { role: "router", models_autoload: false }
    );
    const providersFile = await llamaCppProvidersFile(stateDir, baseUrl);

    const connection = await resolveRuntime({
      ...options(),
      runtime: "auto",
      model: "auto",
      providersFile
    });

    expect(connection.catalogModels).toEqual([
      expect.objectContaining({ modelId: "bonsai-27b", capabilities: ["text", "image"] }),
      expect.objectContaining({ modelId: "text-only-27b", capabilities: ["text"] })
    ]);
  });

  it("offers unloaded llama.cpp models only when the server autoloads", async () => {
    const { stateDir } = await tempRuntimeState();
    const baseUrl = await startModelListServer(
      [{ id: "qwen3-27b", status: { value: "unloaded" } }],
      { role: "router", models_autoload: true }
    );
    const providersFile = await llamaCppProvidersFile(stateDir, baseUrl);

    await expect(
      resolveRuntime({ ...options(), runtime: "auto", model: "auto", providersFile })
    ).resolves.toMatchObject({
      runtime: "llama-cpp",
      providerId: "llama-cpp",
      baseUrl,
      model: "qwen3-27b"
    });
  });

  it("reports llama.cpp models that are unloaded and not autoloaded", async () => {
    const { stateDir } = await tempRuntimeState();
    const baseUrl = await startModelListServer(
      [{ id: "qwen3-27b", status: { value: "unloaded" } }],
      { role: "router", models_autoload: false }
    );
    const providersFile = await llamaCppProvidersFile(stateDir, baseUrl);

    const status = await statusOutput({ ...options(), runtime: "auto", providersFile });
    expect(status).toContain("loaded models: none");
    expect(status).toContain("llama.cpp reported unloaded models: qwen3-27b");
  });

  it("runs the explicit llama-cpp runtime against a llama.cpp endpoint", async () => {
    const baseUrl = await startModelServer("served-model");

    await expect(
      resolveRuntime({ ...options(), runtime: "llama-cpp", baseUrl, model: "served-model" })
    ).resolves.toMatchObject({
      runtime: "llama-cpp",
      providerId: "llama-cpp",
      model: "served-model"
    });
  });

  it("selects explicitly configured providers with discovery disabled", async () => {
    const { stateDir } = await tempRuntimeState();
    const providersFile = path.join(stateDir, "providers.json");
    await writeFile(
      providersFile,
      JSON.stringify({
        providers: {
          vllm: {
            type: "openai-compatible",
            name: "vLLM",
            baseUrl: "http://127.0.0.1:8000/v1",
            discover: false
          }
        }
      })
    );

    await expect(
      resolveRuntime({
        ...options(),
        runtime: "auto",
        provider: "vllm",
        model: "qwen",
        providersFile
      })
    ).resolves.toMatchObject({
      runtime: "vllm",
      providerId: "vllm",
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "qwen",
      availableModels: ["qwen"]
    });
  });

  it("selects profile aliases for providers with discovery disabled", async () => {
    const { stateDir } = await tempRuntimeState();
    const providersFile = path.join(stateDir, "providers.json");
    const profilePath = path.join(stateDir, "profile.json");
    await writeFile(providersFile, JSON.stringify({ providers: builtInProviderOverrides() }));
    await writeFile(
      profilePath,
      JSON.stringify({
        id: "gemma4-26b-a4b-nvfp4",
        model: "nvidia/Gemma-4-26B-A4B-NVFP4",
        base_url: "http://127.0.0.1:8000/v1",
        capabilities: {
          reasoning: true,
          thinking_format: "qwen-chat-template"
        }
      })
    );

    await expect(
      resolveRuntime({
        ...options(),
        runtime: "auto",
        provider: "vllm",
        model: "gemma4-26b-a4b-nvfp4",
        providersFile,
        modelProfileFile: profilePath
      })
    ).resolves.toMatchObject({
      runtime: "vllm",
      providerId: "vllm",
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "nvidia/Gemma-4-26B-A4B-NVFP4",
      availableModels: ["nvidia/Gemma-4-26B-A4B-NVFP4"],
      catalogModels: [
        {
          modelId: "nvidia/Gemma-4-26B-A4B-NVFP4",
          aliases: ["gemma4-26b-a4b-nvfp4"],
          reasoning: true,
          thinkingFormat: "qwen-chat-template"
        }
      ]
    });
  });

  it("starts explicit GGUF paths through the auto runtime", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await unusedBaseUrl();
    const serverCommand = await fakeOpenAiLlamaServerCommand(stateDir);
    const providersFile = await disabledBuiltInProvidersFile(stateDir);

    await expectAutoGgufResult(
      resolveRuntime({
        ...options(),
        runtime: "auto",
        stateDir,
        baseUrl,
        model: modelPath,
        providersFile,
        serverCommand
      }),
      {
        runtime: "llama-server",
        providerId: "llama-server",
        model: "custom-model",
        catalogModels: [
          expect.objectContaining({ providerId: "llama-server", modelId: "custom-model" })
        ]
      }
    );
    await stopManagedLlamaServer({ ...options(), stateDir });
  });

  it("preserves provider-prefixed relative GGUF paths in auto runtime", async () => {
    const { stateDir } = await tempRuntimeState();
    const baseUrl = await unusedBaseUrl();
    const serverCommand = await fakeOpenAiLlamaServerCommand(stateDir);
    const providersFile = await disabledBuiltInProvidersFile(stateDir);

    const result = await autoGgufResult(
      resolveRuntime({
        ...options(),
        runtime: "auto",
        stateDir,
        baseUrl,
        model: "llama-server/custom-model.gguf",
        providersFile,
        serverCommand
      })
    );
    if (result === "blocked-by-loaded-provider") {
      return;
    }
    expect(result).toMatchObject({
      runtime: "llama-server",
      providerId: "llama-server",
      model: "custom-model"
    });
    const args = JSON.parse(
      await readFile(path.join(stateDir, "fake-openai-server.args.json"), "utf8")
    ) as string[];
    expect(args[args.indexOf("--model") + 1]).toBe("llama-server/custom-model.gguf");
    await stopManagedLlamaServer({ ...options(), stateDir });
  });

  async function expectAutoGgufResult(
    promise: Promise<Awaited<ReturnType<typeof resolveRuntime>>>,
    expected: Record<string, unknown>
  ): Promise<void> {
    const result = await autoGgufResult(promise);
    if (result === "blocked-by-loaded-provider") {
      return;
    }
    expect(result).toMatchObject(expected);
  }

  async function autoGgufResult(
    promise: Promise<Awaited<ReturnType<typeof resolveRuntime>>>
  ): Promise<Awaited<ReturnType<typeof resolveRuntime>> | "blocked-by-loaded-provider"> {
    try {
      return await promise;
    } catch (error) {
      expect(String(error)).toMatch(
        /LM Studio also reports loaded models|external local models are already loaded/
      );
      return "blocked-by-loaded-provider";
    }
  }

  it("does not start managed llama-server while external providers have loaded models", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await startModelServer("qwen-vllm", 131072);
    const modelsFile = path.join(stateDir, "models.json");
    await writeFile(
      modelsFile,
      JSON.stringify({
        providers: {
          vllm: {
            type: "openai-compatible",
            name: "vLLM",
            baseUrl,
            discover: true
          }
        },
        models: { custom: { id: "custom-id", path: modelPath } }
      })
    );
    const previousModelsFile = process.env["LOCALPI_MODELS_FILE"];
    process.env["LOCALPI_MODELS_FILE"] = modelsFile;

    try {
      await expect(
        resolveRuntime({
          ...options(),
          runtime: "auto",
          model: "custom",
          providersFile: modelsFile,
          serverCommand: "/definitely/missing/localpi-llama-server"
        })
      ).rejects.toThrow("external local models are already loaded");
    } finally {
      restoreOptionalEnv("LOCALPI_MODELS_FILE", previousModelsFile);
    }
  });

  it("does not start direct llama-server while external providers have loaded models", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await startModelServer("qwen-vllm", 131072);
    const providersFile = path.join(stateDir, "providers.json");
    await writeFile(
      providersFile,
      JSON.stringify({
        providers: {
          vllm: {
            type: "openai-compatible",
            name: "vLLM",
            baseUrl,
            discover: true
          }
        }
      })
    );

    await expect(
      resolveRuntime({
        ...options(),
        runtime: "llama-server",
        stateDir,
        model: modelPath,
        providersFile,
        serverCommand: "/definitely/missing/localpi-llama-server"
      })
    ).rejects.toThrow("external local models are already loaded");
  });

  it("selects already-loaded llama-server models by alias in auto runtime", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await startModelServer("custom-id", 4096);
    const modelsFile = path.join(stateDir, "models.json");
    await writeFile(
      modelsFile,
      JSON.stringify({
        providers: builtInProviderOverrides(),
        models: { custom: { id: "custom-id", path: modelPath } }
      })
    );
    const previousModelsFile = process.env["LOCALPI_MODELS_FILE"];
    process.env["LOCALPI_MODELS_FILE"] = modelsFile;

    try {
      await expect(
        resolveRuntime({ ...options(), runtime: "auto", stateDir, baseUrl, model: "custom" })
      ).resolves.toMatchObject({
        runtime: "llama-server",
        providerId: "llama-server",
        model: "custom-id",
        contextWindow: 4096
      });
    } finally {
      restoreOptionalEnv("LOCALPI_MODELS_FILE", previousModelsFile);
    }
  });

  it("preserves reasoning metadata for already-loaded llama-server reasoning models", async () => {
    const baseUrl = await startModelServer("gemma-4-12b-it", 32768);

    await expect(
      resolveRuntime({
        ...options(),
        runtime: "llama-server",
        baseUrl,
        model: "gemma-4-12b-it"
      })
    ).resolves.toMatchObject({
      model: "gemma-4-12b-it",
      catalogModels: [{ modelId: "gemma-4-12b-it", reasoning: true }]
    });
  });

  it("applies capability overrides to already-loaded llama-server models", async () => {
    const baseUrl = await startModelServer("gemma-4-12b-it", 32768);

    await expect(
      resolveRuntime({
        ...options(),
        runtime: "llama-server",
        baseUrl,
        model: "gemma-4-12b-it",
        modelReasoning: false,
        modelThinkingFormat: "qwen-chat-template"
      })
    ).resolves.toMatchObject({
      model: "gemma-4-12b-it",
      catalogModels: [
        {
          modelId: "gemma-4-12b-it",
          reasoning: false,
          thinkingFormat: "qwen-chat-template"
        }
      ]
    });
  });

  it("does not probe the managed endpoint as an external provider", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await startModelServer("custom-id", 4096);
    const modelsFile = path.join(stateDir, "models.json");
    await writeFile(
      modelsFile,
      JSON.stringify({
        providers: builtInProviderOverrides({
          vllm: {
            type: "openai-compatible",
            name: "vLLM",
            baseUrl,
            discover: true
          }
        }),
        models: { custom: { id: "custom-id", path: modelPath } }
      })
    );
    const previousModelsFile = process.env["LOCALPI_MODELS_FILE"];
    process.env["LOCALPI_MODELS_FILE"] = modelsFile;

    try {
      await expect(
        resolveRuntime({
          ...options(),
          runtime: "auto",
          stateDir,
          baseUrl,
          model: "auto",
          providersFile: modelsFile
        })
      ).resolves.toMatchObject({
        runtime: "llama-server",
        providerId: "llama-server",
        model: "custom-id"
      });
    } finally {
      restoreOptionalEnv("LOCALPI_MODELS_FILE", previousModelsFile);
    }
  });

  it("reuses loaded llama-server aliases while external providers are loaded", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await startModelServer("custom-id", 4096);
    const externalBaseUrl = await startModelServer("qwen-vllm", 131072);
    const modelsFile = path.join(stateDir, "models.json");
    await writeFile(
      modelsFile,
      JSON.stringify({
        providers: {
          vllm: {
            type: "openai-compatible",
            name: "vLLM",
            baseUrl: externalBaseUrl,
            discover: true
          }
        },
        models: { custom: { id: "custom-id", path: modelPath } }
      })
    );
    const previousModelsFile = process.env["LOCALPI_MODELS_FILE"];
    process.env["LOCALPI_MODELS_FILE"] = modelsFile;

    try {
      await expect(
        resolveRuntime({
          ...options(),
          runtime: "auto",
          stateDir,
          baseUrl,
          provider: "llama-server",
          model: "custom"
        })
      ).resolves.toMatchObject({
        runtime: "llama-server",
        providerId: "llama-server",
        model: "custom-id",
        contextWindow: 4096
      });
    } finally {
      restoreOptionalEnv("LOCALPI_MODELS_FILE", previousModelsFile);
    }
  });

  it("reports auto status without starting startable llama-server models", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const modelsFile = path.join(stateDir, "models.json");
    await writeFile(
      modelsFile,
      JSON.stringify({
        providers: builtInProviderOverrides(),
        models: { custom: { id: "custom-id", path: modelPath } }
      })
    );
    const previousModelsFile = process.env["LOCALPI_MODELS_FILE"];
    process.env["LOCALPI_MODELS_FILE"] = modelsFile;

    try {
      const output = await statusOutput({
        ...options(),
        runtime: "auto",
        stateDir,
        serverCommand: "/definitely/missing/localpi-llama-server"
      });
      expect(output).toContain("runtime: auto");
      expect(output).toContain("startable models: llama-server/custom-id");
      await expect(
        readFile(path.join(stateDir, "server", "llama-server.json"), "utf8")
      ).rejects.toThrow();
    } finally {
      restoreOptionalEnv("LOCALPI_MODELS_FILE", previousModelsFile);
    }
  });

  it("reports catalog status without selecting among multiple external models", async () => {
    const baseUrl = await startModelListServer([{ id: "first" }, { id: "second" }]);

    await expect(
      statusOutput({ ...options(), runtime: "lmstudio", baseUrl, model: undefined })
    ).resolves.toContain("loaded models: lmstudio/first, lmstudio/second");
  });

  it("uses the first loaded model as the Pi bootstrap model when multiple are loaded", async () => {
    const baseUrl = await startModelListServer([{ id: "first" }, { id: "second" }]);

    await expect(
      resolveRuntime({ ...options(), runtime: "lmstudio", baseUrl, model: "auto" })
    ).resolves.toMatchObject({
      runtime: "lmstudio",
      model: "first",
      availableModels: ["first", "second"],
      catalogModels: [{ modelId: "first" }, { modelId: "second" }]
    });
  });

  it("reports no loaded models when auto discovery finds no usable models", async () => {
    const { stateDir } = await tempRuntimeState();
    const providersFile = await disabledBuiltInProvidersFile(stateDir);
    const previousHome = process.env["HOME"];
    process.env["HOME"] = stateDir;

    try {
      await expect(
        resolveRuntime({
          ...options(),
          runtime: "auto",
          model: "auto",
          providersFile,
          timeoutMs: 10
        })
      ).rejects.toThrow("no loaded models available");
    } finally {
      restoreOptionalEnv("HOME", previousHome);
    }
  });

  it("does not require llama-server for auto mode when no loaded model exists", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const modelsFile = path.join(stateDir, "models.json");
    await writeFile(
      modelsFile,
      JSON.stringify({
        providers: builtInProviderOverrides(),
        models: { custom: { id: "custom-id", path: modelPath } }
      })
    );
    const previousModelsFile = process.env["LOCALPI_MODELS_FILE"];
    process.env["LOCALPI_MODELS_FILE"] = modelsFile;

    try {
      await expect(
        resolveRuntime({
          ...options(),
          runtime: "auto",
          stateDir,
          model: "auto",
          providersFile: modelsFile,
          serverCommand: "/definitely/missing/localpi-llama-server"
        })
      ).rejects.toThrow(
        /no loaded models available\n\nTried engines:\n\nllama-server:\n- loaded models: none\n- startable models: .*llama-server\/custom-id.*\n- llama-server command \/definitely\/missing\/localpi-llama-server is not available; managed llama-server fallback disabled/u
      );
      await expect(
        readFile(path.join(stateDir, "server", "llama-server.json"), "utf8")
      ).rejects.toThrow();
    } finally {
      restoreOptionalEnv("LOCALPI_MODELS_FILE", previousModelsFile);
    }
  });

  it("computes the effective base URL per runtime", () => {
    expect(effectiveBaseUrl(options())).toBe("http://127.0.0.1:18194/v1");
    expect(effectiveBaseUrl({ ...options(), runtime: "lmstudio" })).toBe(
      "http://127.0.0.1:1234/v1"
    );
    expect(effectiveBaseUrl({ ...options(), runtime: "vllm" })).toBe("http://127.0.0.1:8000/v1");
    expect(effectiveBaseUrl({ ...options(), runtime: "llama-cpp" })).toBe(
      "http://127.0.0.1:8080/v1"
    );
    expect(
      effectiveBaseUrl({ ...options(), runtime: "lmstudio", baseUrl: "http://10.0.0.5:1/v1" })
    ).toBe("http://10.0.0.5:1/v1");
    expect(
      effectiveBaseUrl({
        ...options(),
        runtime: "openai-compatible",
        baseUrl: "http://10.0.0.5:1/v1"
      })
    ).toBe("http://10.0.0.5:1/v1");
    expect(() => effectiveBaseUrl({ ...options(), runtime: "openai-compatible" })).toThrow(
      "--runtime openai-compatible requires --base-url"
    );
  });

  it("rejects reusing an external server with a mismatched context window", async () => {
    const { stateDir } = await tempRuntimeState();
    const baseUrl = await startModelServer("served-model", 4096);

    await expect(
      resolveRuntime({
        ...options(),
        stateDir,
        baseUrl,
        model: "served-model",
        contextWindow: 8192
      })
    ).rejects.toThrow(
      `server at ${baseUrl} reports served-model ctx=4096, but --ctx 8192 was requested`
    );
  });

  it("rejects unknown models that are not served or aliased", async () => {
    const { stateDir } = await tempRuntimeState();
    const baseUrl = await startModelServer("other-model");

    await expect(
      resolveRuntime({ ...options(), stateDir, baseUrl, model: "custom-model" })
    ).rejects.toThrow("unknown llama-server model alias custom-model");
  });

  it("maps alias names onto models an external server already serves", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await startModelServer("custom-id", 4096);
    const modelsFile = path.join(stateDir, "models.json");
    await writeFile(
      modelsFile,
      JSON.stringify({ models: { custom: { id: "custom-id", path: modelPath } } })
    );
    const previousModelsFile = process.env["LOCALPI_MODELS_FILE"];
    process.env["LOCALPI_MODELS_FILE"] = modelsFile;

    try {
      await expect(
        resolveRuntime({ ...options(), stateDir, baseUrl, model: "custom" })
      ).resolves.toMatchObject({
        runtime: "llama-server/external",
        model: "custom-id",
        contextWindow: 4096
      });
    } finally {
      restoreOptionalEnv("LOCALPI_MODELS_FILE", previousModelsFile);
    }
  });

  it("fast-reuses a managed llama-server with unchanged options", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await startModelServer("custom-model", 32768);
    const child = spawnFakeLlamaServer(modelPath);
    await writeMetadata(stateDir, {
      pid: child.pid ?? 0,
      baseUrl,
      modelId: "custom-model",
      modelPath,
      contextWindow: 32768,
      serverCommand: "llama-server",
      host: "127.0.0.1",
      port: Number.parseInt(new URL(baseUrl).port, 10),
      gpuLayers: 999,
      parallel: 1
    });

    await expect(
      resolveRuntime({ ...options(), stateDir, baseUrl, model: "auto" })
    ).resolves.toMatchObject({
      runtime: "llama-server",
      model: "custom-model",
      contextWindow: 32768
    });
  });

  it("recovers managed model metadata when resolution fails and the server is down", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await unusedBaseUrl();
    const providersFile = await disabledBuiltInProvidersFile(stateDir);
    const child = spawnFakeLlamaServer(modelPath);
    await writeMetadata(stateDir, {
      pid: child.pid ?? 0,
      baseUrl,
      modelId: "managed-model",
      modelPath,
      contextWindow: 4096,
      serverCommand: "llama-server",
      host: "127.0.0.1",
      port: Number.parseInt(new URL(baseUrl).port, 10),
      gpuLayers: 999,
      parallel: 1
    });

    await expect(
      resolveRuntime({
        ...options(),
        stateDir,
        baseUrl,
        model: "managed-model",
        providersFile,
        serverCommand: "/definitely/missing/localpi-llama-server"
      })
    ).rejects.toThrow(/failed to start llama-server|LM Studio also reports loaded models/);
    await waitForDead(child.pid ?? 0);
  });

  it("restarts a managed llama-server when the requested context changes", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await startModelServer("custom-model", 32768);
    const providersFile = await disabledBuiltInProvidersFile(stateDir);
    const child = spawnFakeLlamaServer(modelPath);
    const serverCommand = "/definitely/missing/localpi-llama-server";
    await writeMetadata(stateDir, {
      pid: child.pid ?? 0,
      baseUrl,
      modelId: "custom-model",
      modelPath,
      contextWindow: 32768,
      serverCommand,
      host: "127.0.0.1",
      port: Number.parseInt(new URL(baseUrl).port, 10),
      gpuLayers: 999,
      parallel: 1
    });

    await expect(
      resolveRuntime({
        ...options(),
        stateDir,
        baseUrl,
        model: "custom-model",
        contextWindow: 65536,
        providersFile,
        serverCommand
      })
    ).rejects.toThrow(/failed to start llama-server|LM Studio also reports loaded models/);
    await waitForDead(child.pid ?? 0);
  });

  it("reuses an external llama-server without managed metadata", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await startModelServer("custom-model", 8192);

    await expect(
      ensureLlamaServer({ ...options(), stateDir, baseUrl }, { id: "custom-model", modelPath })
    ).resolves.toMatchObject({
      baseUrl,
      model: "custom-model",
      managed: false,
      contextWindow: 8192,
      availableModels: ["custom-model"]
    });
  });

  it("reuses a managed llama-server when the model and options match", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await startModelServer("custom-model", 32768);
    const child = spawnFakeLlamaServer(modelPath);
    await writeMetadata(stateDir, {
      pid: child.pid ?? 0,
      baseUrl,
      modelId: "custom-model",
      modelPath,
      contextWindow: 32768,
      serverCommand: "llama-server",
      host: "127.0.0.1",
      port: Number.parseInt(new URL(baseUrl).port, 10),
      gpuLayers: 999,
      parallel: 1
    });

    await expect(
      ensureLlamaServer(
        { ...options(), stateDir, baseUrl },
        { id: "custom-model", modelPath, contextWindow: 32768 }
      )
    ).resolves.toMatchObject({ managed: true, model: "custom-model", contextWindow: 32768 });
  });

  it("refuses to replace an external server serving another model", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await startModelServer("other-model");

    await expect(
      ensureLlamaServer({ ...options(), stateDir, baseUrl }, { id: "custom-model", modelPath })
    ).rejects.toThrow(
      `server at ${baseUrl} is already serving other-model; stop it or choose that model before starting custom-model`
    );
  });

  it("rejects an external server with a conflicting context window", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await startModelServer("custom-model", 4096);

    await expect(
      ensureLlamaServer(
        { ...options(), stateDir, baseUrl, contextWindow: 8192 },
        { id: "custom-model", modelPath }
      )
    ).rejects.toThrow(
      `server at ${baseUrl} reports custom-model ctx=4096, but --ctx 8192 was requested`
    );
  });

  it("reports llama-server processes that exit during startup", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const commandPath = path.join(stateDir, "fake-exiting-llama-server");
    await writeFile(commandPath, "#!/bin/sh\nexit 3\n");
    await chmod(commandPath, 0o755);
    const previousTimeout = process.env["LOCALPI_SERVER_STARTUP_TIMEOUT_MS"];
    process.env["LOCALPI_SERVER_STARTUP_TIMEOUT_MS"] = "2000";

    try {
      await expect(
        ensureLlamaServer(
          { ...options(), stateDir, baseUrl: await unusedBaseUrl(), serverCommand: commandPath },
          { id: "custom-model", modelPath, contextWindow: 4096 }
        )
      ).rejects.toThrow(
        /exited before startup completed \(exit code 3\)|did not become ready|LM Studio also reports loaded models/
      );
    } finally {
      restoreStartupTimeout(previousTimeout);
    }
  });

  it("reports the served models when startup readiness fails", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const serverCommand = await fakeOpenAiLlamaServerCommand(stateDir, "wrong-model");
    const previousTimeout = process.env["LOCALPI_SERVER_STARTUP_TIMEOUT_MS"];
    process.env["LOCALPI_SERVER_STARTUP_TIMEOUT_MS"] = "2500";

    try {
      await expect(
        ensureLlamaServer(
          { ...options(), stateDir, baseUrl: await unusedBaseUrl(), serverCommand },
          { id: "custom-model", modelPath, contextWindow: 4096 }
        )
      ).rejects.toThrow(
        /server reported: wrong-model|did not become ready|LM Studio also reports loaded models/
      );
    } finally {
      restoreStartupTimeout(previousTimeout);
    }
  });

  it("stops a managed llama-server process when readiness times out", async () => {
    const { stateDir, modelPath } = await tempRuntimeState();
    const serverCommand = await fakeLlamaServerCommand(stateDir);
    const previousTimeout = process.env["LOCALPI_SERVER_STARTUP_TIMEOUT_MS"];
    process.env["LOCALPI_SERVER_STARTUP_TIMEOUT_MS"] = "100";
    try {
      await expect(
        ensureLlamaServer(
          {
            ...options(),
            stateDir,
            baseUrl: await unusedBaseUrl(),
            serverCommand
          },
          { id: "custom-model", modelPath, contextWindow: 4096 }
        )
      ).rejects.toThrow(/did not become ready|LM Studio also reports loaded models/);

      if (await fileExists(path.join(stateDir, "fake-server.pid"))) {
        const pid = Number.parseInt(
          await readFile(path.join(stateDir, "fake-server.pid"), "utf8"),
          10
        );
        await waitForDead(pid);
      }
    } finally {
      restoreStartupTimeout(previousTimeout);
    }
  });

  async function startModelServer(model: string, contextWindow = 4096): Promise<string> {
    return startModelListServer([{ id: model, context_length: contextWindow }]);
  }

  async function startModelListServer(
    models: readonly Record<string, unknown>[],
    props?: Record<string, unknown>
  ): Promise<string> {
    const server = createServer((request, response) => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: models }));
        return;
      }
      if (props !== undefined && request.url === "/props") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(props));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    servers.push(server);
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${String(address.port)}/v1`;
  }

  async function unusedBaseUrl(): Promise<string> {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${String(address.port)}/v1`;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    return baseUrl;
  }

  async function tempRuntimeState(): Promise<{
    readonly stateDir: string;
    readonly modelPath: string;
  }> {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-runtime-"));
    tempDirs.push(stateDir);
    const modelPath = path.join(stateDir, "custom-model.gguf");
    await writeFile(modelPath, "");
    return { stateDir, modelPath };
  }

  function builtInProviderOverrides(
    overrides: Record<string, Record<string, unknown>> = {}
  ): Record<string, Record<string, unknown>> {
    return {
      lmstudio: {
        type: "openai-compatible",
        baseUrl: "http://127.0.0.1:1234/v1",
        discover: false
      },
      vllm: {
        type: "openai-compatible",
        baseUrl: "http://127.0.0.1:8000/v1",
        discover: false
      },
      "llama-cpp": {
        type: "llama-cpp",
        baseUrl: "http://127.0.0.1:8080/v1",
        discover: false
      },
      ...overrides
    };
  }

  async function disabledBuiltInProvidersFile(stateDir: string): Promise<string> {
    const providersFile = path.join(stateDir, "providers.json");
    await writeFile(providersFile, JSON.stringify({ providers: builtInProviderOverrides() }));
    return providersFile;
  }

  async function llamaCppProvidersFile(stateDir: string, baseUrl: string): Promise<string> {
    const providersFile = path.join(stateDir, "llama-cpp-providers.json");
    await writeFile(
      providersFile,
      JSON.stringify({
        providers: builtInProviderOverrides({
          "llama-cpp": {
            type: "llama-cpp",
            name: "llama.cpp",
            baseUrl,
            discover: true
          }
        })
      })
    );
    return providersFile;
  }

  function spawnFakeLlamaServer(modelPath: string): ChildProcess {
    return spawnFakeOwnedProcess("llama-server", modelPath);
  }

  function spawnFakeOwnedProcess(commandMarker: string, modelPath: string): ChildProcess {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", commandMarker, modelPath],
      { stdio: "ignore" }
    );
    children.push(child);
    return child;
  }

  async function writeMetadata(
    stateDir: string,
    metadata: {
      readonly pid: number;
      readonly baseUrl: string;
      readonly modelId: string;
      readonly modelPath: string;
      readonly contextWindow: number;
      readonly serverCommand: string;
      readonly host: string;
      readonly port: number;
      readonly gpuLayers?: number;
      readonly parallel?: number;
      readonly chatTemplate?: string;
      readonly reasoningMode?: "off" | "on";
      readonly reasoningBudget?: number;
    }
  ): Promise<void> {
    const serverDir = path.join(stateDir, "server");
    await mkdir(serverDir, { recursive: true });
    await writeFile(path.join(serverDir, "llama-server.json"), `${JSON.stringify(metadata)}\n`);
  }

  async function fakeLlamaServerCommand(stateDir: string): Promise<string> {
    const commandPath = path.join(stateDir, "fake-llama-server");
    await writeFile(
      commandPath,
      [
        "#!/bin/sh",
        `echo $$ > ${shellQuote(path.join(stateDir, "fake-server.pid"))}`,
        "trap 'exit 0' TERM",
        "while true; do sleep 1; done"
      ].join("\n")
    );
    await chmod(commandPath, 0o755);
    return commandPath;
  }

  async function fakeOpenAiLlamaServerCommand(
    stateDir: string,
    servedModelId?: string
  ): Promise<string> {
    const commandPath = path.join(stateDir, "fake-openai-llama-server");
    const pidPath = path.join(stateDir, "fake-openai-server.pid");
    const argsPath = path.join(stateDir, "fake-openai-server.args.json");
    await writeFile(
      commandPath,
      [
        "#!/usr/bin/env node",
        'const http = require("node:http");',
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        "const value = (flag) => args[args.indexOf(flag) + 1];",
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));`,
        'const host = value("--host") || "127.0.0.1";',
        'const port = Number(value("--port"));',
        `const alias = ${JSON.stringify(servedModelId ?? null)} ?? value("--alias") ?? "custom-model";`,
        'const ctx = Number(value("--ctx-size") || "32768");',
        "const server = http.createServer((request, response) => {",
        '  if (request.url === "/v1/models") {',
        '    response.writeHead(200, { "content-type": "application/json" });',
        "    response.end(JSON.stringify({ data: [{ id: alias, context_length: ctx }] }));",
        "    return;",
        "  }",
        "  response.writeHead(404);",
        "  response.end();",
        "});",
        "server.listen(port, host);",
        'process.on("SIGTERM", () => server.close(() => process.exit(0)));'
      ].join("\n")
    );
    await chmod(commandPath, 0o755);
    return commandPath;
  }

  async function waitForDead(pid: number): Promise<void> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && isAlive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(isAlive(pid)).toBe(false);
  }

  /** Starts a managed server with a thinking level and optional budget and message overrides. */
  async function startServerWithReasoning(
    thinking: LocalpiOptions["thinking"],
    thinkingBudget?: number,
    thinkingBudgetMessage?: string
  ): Promise<{ readonly stateDir: string; readonly args: readonly string[] }> {
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await unusedBaseUrl();
    const serverCommand = await fakeOpenAiLlamaServerCommand(stateDir);
    await ensureLlamaServer(
      {
        ...options(),
        stateDir,
        baseUrl,
        thinking,
        ...(thinkingBudget === undefined ? {} : { thinkingBudget }),
        ...(thinkingBudgetMessage === undefined ? {} : { thinkingBudgetMessage }),
        serverCommand
      },
      { id: "custom-model", modelPath }
    );
    return { stateDir, args: await readFakeServerArgs(stateDir) };
  }

  async function readFakeServerArgs(stateDir: string): Promise<readonly string[]> {
    return JSON.parse(
      await readFile(path.join(stateDir, "fake-openai-server.args.json"), "utf8")
    ) as string[];
  }

  async function readFakeServerMetadata(stateDir: string): Promise<FakeReasoningMetadata> {
    return JSON.parse(
      await readFile(path.join(stateDir, "server", "llama-server.json"), "utf8")
    ) as FakeReasoningMetadata;
  }
});

type FakeReasoningMetadata = {
  readonly reasoningMode?: string;
  readonly reasoningBudget?: number;
  readonly reasoningMessage?: string;
};

function options(): LocalpiOptions {
  const stateDir = "/tmp/localpi-runtime-test";
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
    piCommand: ["pi"],
    thinking: "off",
    thinkingBudget: undefined,
    thinkingBudgetMessage: undefined,
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
    demo: false,
    demoFromCli: false,
    demoInitialPrompt: undefined,
    demoInitialPromptFile: undefined,
    demoFollowupPrompt: undefined,
    demoFollowupPromptFile: undefined,
    acp: false,
    acpFromCli: false,
    status: false,
    stop: false,
    list: false,
    forwardedArgs: []
  };
}

function isAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function restoreStartupTimeout(value: string | undefined): void {
  restoreOptionalEnv("LOCALPI_SERVER_STARTUP_TIMEOUT_MS", value);
}

function restoreOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  process.env[name] = value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
