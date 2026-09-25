import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LocalpiOptions } from "../src/localpi/options.js";
import type { ManagedLlamaServerMetadata } from "../src/localpi/llama-server.js";
import {
  isManagedLlamaServerActive,
  llamaBaseUrl,
  llamaServerStatus,
  managedLlamaServerNeedsRestart,
  reasoningBudgetMessage,
  reasoningConfig,
  stopManagedLlamaServer
} from "../src/localpi/llama-server.js";

describe("llama-server state", () => {
  const children: ChildProcess[] = [];
  const tempDirs: string[] = [];
  const previousSafetyProbe = process.env["LOCALPI_LMSTUDIO_SAFETY_PROBE"];

  beforeEach(() => {
    process.env["LOCALPI_LMSTUDIO_SAFETY_PROBE"] = "0";
  });

  afterEach(async () => {
    restoreOptionalEnv("LOCALPI_LMSTUDIO_SAFETY_PROBE", previousSafetyProbe);
    for (const child of children) {
      if (child.pid !== undefined) {
        child.kill("SIGKILL");
      }
    }
    children.length = 0;
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("derives the base URL from host and port or a normalized override", () => {
    expect(llamaBaseUrl(options())).toBe("http://127.0.0.1:18194/v1");
    expect(llamaBaseUrl({ ...options(), baseUrl: "http://10.0.0.5:8080/v1/" })).toBe(
      "http://10.0.0.5:8080/v1"
    );
  });

  it("does not restart a managed server whose options are unchanged", () => {
    expect(managedLlamaServerNeedsRestart(options(), metadata())).toBe(false);
  });

  it("maps thinking levels onto reasoning budgets when comparing servers", () => {
    const cases: readonly (readonly [LocalpiOptions["thinking"], number])[] = [
      ["minimal", 32],
      ["low", 128],
      ["medium", 512],
      ["high", 2048],
      ["xhigh", 16384]
    ];
    for (const [thinking, budget] of cases) {
      const info = {
        ...metadata(),
        reasoningMode: "on" as const,
        reasoningBudget: budget,
        reasoningMessage: reasoningBudgetMessage
      };
      expect(managedLlamaServerNeedsRestart({ ...options(), thinking }, info)).toBe(false);
      expect(managedLlamaServerNeedsRestart({ ...options(), thinking }, metadata())).toBe(true);
    }
  });

  it("restarts when the thinking budget override changes", () => {
    const info = {
      ...metadata(),
      reasoningMode: "on" as const,
      reasoningBudget: 4096,
      reasoningMessage: reasoningBudgetMessage
    };
    expect(
      managedLlamaServerNeedsRestart(
        { ...options(), thinking: "medium", thinkingBudget: 4096 },
        info
      )
    ).toBe(false);
    expect(
      managedLlamaServerNeedsRestart(
        { ...options(), thinking: "medium", thinkingBudget: 8192 },
        info
      )
    ).toBe(true);
    expect(managedLlamaServerNeedsRestart({ ...options(), thinking: "medium" }, info)).toBe(true);
  });

  it("records no message for an unrestricted thinking budget", () => {
    const info = { ...metadata(), reasoningMode: "on" as const, reasoningBudget: -1 };
    expect(
      managedLlamaServerNeedsRestart({ ...options(), thinking: "medium", thinkingBudget: -1 }, info)
    ).toBe(false);
    expect(managedLlamaServerNeedsRestart({ ...options(), thinking: "medium" }, info)).toBe(true);
  });

  it("maps every thinking level to a budget and a message", () => {
    expect(reasoningConfig("off")).toEqual({ mode: "off" });
    expect(reasoningConfig("minimal")).toEqual({
      mode: "on",
      budget: 32,
      message: reasoningBudgetMessage
    });
    expect(reasoningConfig("low")).toEqual({
      mode: "on",
      budget: 128,
      message: reasoningBudgetMessage
    });
    expect(reasoningConfig("medium")).toEqual({
      mode: "on",
      budget: 512,
      message: reasoningBudgetMessage
    });
    expect(reasoningConfig("high")).toEqual({
      mode: "on",
      budget: 2048,
      message: reasoningBudgetMessage
    });
    expect(reasoningConfig("xhigh")).toEqual({
      mode: "on",
      budget: 16384,
      message: reasoningBudgetMessage
    });
  });

  it("replaces the level budget with the override and drops the message when unrestricted", () => {
    expect(reasoningConfig("medium", 4096)).toEqual({
      mode: "on",
      budget: 4096,
      message: reasoningBudgetMessage
    });
    expect(reasoningConfig("xhigh", -1)).toEqual({ mode: "on", budget: -1 });
    expect(reasoningConfig("off", 4096)).toEqual({ mode: "off" });
  });

  it("rewords the message with the override and passes none for empty text", () => {
    expect(reasoningConfig("medium", undefined, "Stop now.")).toEqual({
      mode: "on",
      budget: 512,
      message: "Stop now."
    });
    expect(reasoningConfig("medium", undefined, "")).toEqual({ mode: "on", budget: 512 });
    expect(reasoningConfig("xhigh", -1, "Stop now.")).toEqual({ mode: "on", budget: -1 });
    expect(reasoningConfig("off", undefined, "Stop now.")).toEqual({ mode: "off" });
  });

  it("restarts when the thinking budget message changes", () => {
    const info = {
      ...metadata(),
      reasoningMode: "on" as const,
      reasoningBudget: 512,
      reasoningMessage: "Stop now."
    };
    expect(
      managedLlamaServerNeedsRestart(
        { ...options(), thinking: "medium", thinkingBudgetMessage: "Stop now." },
        info
      )
    ).toBe(false);
    expect(
      managedLlamaServerNeedsRestart(
        { ...options(), thinking: "medium", thinkingBudgetMessage: "Stop." },
        info
      )
    ).toBe(true);
    expect(
      managedLlamaServerNeedsRestart(
        { ...options(), thinking: "medium", thinkingBudgetMessage: "" },
        info
      )
    ).toBe(true);
  });

  it("keeps thinking off even with a budget override", () => {
    expect(
      managedLlamaServerNeedsRestart(
        { ...options(), thinking: "off", thinkingBudget: 4096 },
        metadata()
      )
    ).toBe(false);
  });

  it("restarts when the chat template or model changes", () => {
    expect(
      managedLlamaServerNeedsRestart({ ...options(), chatTemplate: "/tmp/t.jinja" }, metadata())
    ).toBe(true);
    expect(
      managedLlamaServerNeedsRestart(options(), metadata(), {
        id: "custom-model",
        modelPath: "/models/other.gguf",
        contextWindow: 4096
      })
    ).toBe(true);
    expect(
      managedLlamaServerNeedsRestart(options(), metadata(), {
        id: "custom-model",
        modelPath: "/models/custom.gguf",
        contextWindow: 4096
      })
    ).toBe(false);
  });

  it("derives default ports for https base URLs", () => {
    const httpsOptions = { ...options(), baseUrl: "https://models.example/v1" };
    const info = {
      ...metadata(),
      baseUrl: "https://models.example/v1",
      host: "models.example",
      port: 443
    };
    expect(managedLlamaServerNeedsRestart(httpsOptions, info)).toBe(false);
  });

  it("rejects base URLs without a usable port", () => {
    expect(() =>
      managedLlamaServerNeedsRestart({ ...options(), baseUrl: "http://127.0.0.1:0/v1" }, metadata())
    ).toThrow("cannot derive llama-server port from --base-url http://127.0.0.1:0/v1");
  });

  it("reports metadata and probe state in the status output", async () => {
    const stateDir = await tempStateDir();
    const modelPath = path.join(stateDir, "custom-model.gguf");
    const child = spawnOwnedProcess("llama-server", modelPath);
    await writeMetadataFile(stateDir, {
      ...metadata(),
      pid: child.pid ?? 0,
      modelPath,
      reasoningMode: "on",
      reasoningBudget: 128
    });

    const status = await llamaServerStatus({
      ...options(),
      stateDir,
      baseUrl: await unusedBaseUrl(),
      timeoutMs: 200
    });
    expect(status).toContain(`metadata: pid ${String(child.pid ?? 0)}, model custom-model`);
    expect(status).toContain("reasoning on:128");
    expect(status).toContain("server: not responding");
    await expect(isManagedLlamaServerActive({ ...options(), stateDir })).resolves.toBe(true);
  });

  it("discards metadata for dead, malformed, or mismatched entries", async () => {
    const deadStateDir = await tempStateDir();
    await writeMetadataFile(deadStateDir, { ...metadata(), pid: 0 });
    await expect(
      isManagedLlamaServerActive({ ...options(), stateDir: deadStateDir })
    ).resolves.toBe(false);

    const malformedStateDir = await tempStateDir();
    await mkdir(path.join(malformedStateDir, "server"), { recursive: true });
    await writeFile(path.join(malformedStateDir, "server", "llama-server.json"), "{not json");
    const status = await llamaServerStatus({
      ...options(),
      stateDir: malformedStateDir,
      baseUrl: await unusedBaseUrl(),
      timeoutMs: 200
    });
    expect(status).toContain("metadata: none");

    const blankPathStateDir = await tempStateDir();
    const child = spawnOwnedProcess("llama-server", "placeholder");
    await writeMetadataFile(blankPathStateDir, {
      ...metadata(),
      pid: child.pid ?? 0,
      modelPath: ""
    });
    await expect(
      isManagedLlamaServerActive({ ...options(), stateDir: blankPathStateDir })
    ).resolves.toBe(false);
    await expect(
      access(path.join(blankPathStateDir, "server", "llama-server.json"))
    ).rejects.toThrow();
  });

  it("escalates to SIGKILL when a managed server ignores SIGTERM", async () => {
    const stateDir = await tempStateDir();
    const modelPath = path.join(stateDir, "custom-model.gguf");
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
        "llama-server",
        modelPath
      ],
      { stdio: "ignore" }
    );
    children.push(child);
    await new Promise((resolve) => child.once("spawn", resolve));
    await writeMetadataFile(stateDir, { ...metadata(), pid: child.pid ?? 0, modelPath });

    const message = await stopManagedLlamaServer({ ...options(), stateDir });
    expect(message).toBe(`stopped localpi-owned llama-server pid ${String(child.pid ?? 0)}`);
  }, 15000);

  async function tempStateDir(): Promise<string> {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-llama-"));
    tempDirs.push(stateDir);
    return stateDir;
  }

  function spawnOwnedProcess(commandMarker: string, modelPath: string): ChildProcess {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", commandMarker, modelPath],
      { stdio: "ignore" }
    );
    children.push(child);
    return child;
  }

  async function writeMetadataFile(
    stateDir: string,
    value: ManagedLlamaServerMetadata
  ): Promise<void> {
    const serverDir = path.join(stateDir, "server");
    await mkdir(serverDir, { recursive: true });
    await writeFile(path.join(serverDir, "llama-server.json"), `${JSON.stringify(value)}\n`);
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
});

function options(): LocalpiOptions {
  const stateDir = "/tmp/localpi-llama-test";
  return {
    runtime: "llama-server",
    baseUrl: undefined,
    apiKey: "local",
    model: "custom-model",
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

function metadata(): ManagedLlamaServerMetadata {
  return {
    pid: 1,
    baseUrl: "http://127.0.0.1:18194/v1",
    modelId: "custom-model",
    modelPath: "/models/custom.gguf",
    contextWindow: 4096,
    serverCommand: "llama-server",
    host: "127.0.0.1",
    port: 18194,
    gpuLayers: 999,
    parallel: 1,
    reasoningMode: "off"
  };
}

function restoreOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  process.env[name] = value;
}
