import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LocalpiOptions } from "../src/localpi/options.js";
import { ensureLlamaServer, stopManagedLlamaServer } from "../src/localpi/llama-server.js";
import { resolveRuntime } from "../src/localpi/runtime.js";

describe("runtime resolution", () => {
  const servers: ReturnType<typeof createServer>[] = [];
  const children: ChildProcess[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
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
    const { stateDir, modelPath } = await tempRuntimeState();
    const baseUrl = await unusedBaseUrl();
    const serverCommand = await fakeOpenAiLlamaServerCommand(stateDir);
    await ensureLlamaServer(
      {
        ...options(),
        stateDir,
        baseUrl,
        thinking: "low",
        serverCommand
      },
      { id: "custom-model", modelPath }
    );

    const args = JSON.parse(
      await readFile(path.join(stateDir, "fake-openai-server.args.json"), "utf8")
    ) as string[];
    expect(args).toContain("--reasoning");
    expect(args[args.indexOf("--reasoning") + 1]).toBe("on");
    expect(args).toContain("--reasoning-budget");
    expect(args[args.indexOf("--reasoning-budget") + 1]).toBe("128");

    const metadata = JSON.parse(
      await readFile(path.join(stateDir, "server", "llama-server.json"), "utf8")
    ) as { readonly reasoningMode?: string; readonly reasoningBudget?: number };
    expect(metadata.reasoningMode).toBe("on");
    expect(metadata.reasoningBudget).toBe(128);
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
      ).rejects.toThrow(/failed to start llama-server|LM Studio also reports loaded models/);
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
    const server = createServer((request, response) => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: model, context_length: contextWindow }] }));
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

  async function fakeOpenAiLlamaServerCommand(stateDir: string): Promise<string> {
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
        'const alias = value("--alias") || "custom-model";',
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
});

function options(): LocalpiOptions {
  const stateDir = "/tmp/localpi-runtime-test";
  return {
    runtime: "llama-server",
    baseUrl: undefined,
    model: "gemma-12b",
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
