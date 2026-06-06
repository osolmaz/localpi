import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { listModels, normalizeBaseUrl } from "../llm/openai.js";
import type { ModelInfo } from "../llm/openai.js";
import type { LocalpiOptions } from "./options.js";

export type LlamaServerRuntime = {
  readonly baseUrl: string;
  readonly model: string;
  readonly availableModels: readonly string[];
  readonly contextWindow?: number;
  readonly managed: boolean;
  readonly warnings: readonly string[];
};

export type LlamaServerModel = {
  readonly id: string;
  readonly modelPath: string;
  readonly contextWindow?: number;
  readonly chatTemplate?: string;
};

export async function ensureLlamaServer(
  options: LocalpiOptions,
  model: LlamaServerModel
): Promise<LlamaServerRuntime> {
  const baseUrl = llamaBaseUrl(options);
  const warnings = await lmStudioWarnings();
  const existing = await probe(baseUrl, options.timeoutMs);
  if (existing !== undefined) {
    return existingModelRuntime(options, model, baseUrl, existing, warnings);
  }

  await stopManagedLlamaServer(options);
  const pid = await startManagedServer(options, model);
  await writeMetadata(options, metadata(options, model, pid));
  const models = await waitForModels(baseUrl, model.id, startupTimeoutMs());
  return {
    baseUrl,
    model: model.id,
    availableModels: models.map((entry) => entry.id),
    managed: true,
    warnings,
    ...optionalContextWindow(model.contextWindow)
  };
}

export async function stopManagedLlamaServer(options: LocalpiOptions): Promise<string> {
  const info = await readMetadataFile(options);
  if (info === undefined) {
    return "no localpi-owned llama-server metadata found";
  }
  if (isProcessAlive(info.pid)) {
    process.kill(info.pid, "SIGTERM");
    await waitForExit(info.pid, 5000);
  }
  if (isProcessAlive(info.pid)) {
    process.kill(info.pid, "SIGKILL");
    await waitForExit(info.pid, 2000);
  }
  await rm(metadataPath(options), { force: true });
  return `stopped localpi-owned llama-server pid ${String(info.pid)}`;
}

export async function llamaServerStatus(options: LocalpiOptions): Promise<string> {
  const baseUrl = llamaBaseUrl(options);
  const info = await readMetadataFile(options);
  const models = await probe(baseUrl, options.timeoutMs);
  return [
    `runtime: llama-server`,
    `base url: ${baseUrl}`,
    `metadata: ${info === undefined ? "none" : metadataSummary(info)}`,
    `server: ${models === undefined ? "not responding" : models.map((model) => model.id).join(", ")}`
  ].join("\n");
}

export function llamaBaseUrl(options: LocalpiOptions): string {
  return normalizeBaseUrl(options.baseUrl ?? `http://${options.host}:${String(options.port)}/v1`);
}

async function existingModelRuntime(
  options: LocalpiOptions,
  model: LlamaServerModel,
  baseUrl: string,
  existing: readonly ModelInfo[],
  warnings: readonly string[]
): Promise<LlamaServerRuntime> {
  const ids = existing.map((entry) => entry.id);
  if (!ids.includes(model.id)) {
    throw new Error(
      `server at ${baseUrl} is already serving ${ids.join(", ")}; stop it or choose that model before starting ${model.id}`
    );
  }
  return {
    baseUrl,
    model: model.id,
    availableModels: ids,
    managed: (await readMetadataFile(options)) !== undefined,
    warnings,
    ...optionalContextWindow(
      model.contextWindow ?? existing.find((entry) => entry.id === model.id)?.contextWindow
    )
  };
}

async function startManagedServer(
  options: LocalpiOptions,
  model: LlamaServerModel
): Promise<number> {
  await mkdir(serverDir(options), { recursive: true });
  const logPath = path.join(serverDir(options), "llama-server.log");
  const logFd = openSync(logPath, "a");
  try {
    const child = spawn(options.serverCommand, serverArgs(options, model), {
      detached: true,
      stdio: ["ignore", logFd, logFd]
    });
    child.unref();
    return child.pid ?? 0;
  } finally {
    closeSync(logFd);
  }
}

function serverArgs(options: LocalpiOptions, model: LlamaServerModel): readonly string[] {
  return [
    "--host",
    options.host,
    "--port",
    String(options.port),
    "--model",
    model.modelPath,
    "--alias",
    model.id,
    "--ctx-size",
    String(options.contextWindow ?? model.contextWindow ?? 32768),
    "--parallel",
    String(options.parallel),
    "--gpu-layers",
    String(options.gpuLayers),
    ...chatTemplateArgs(model.chatTemplate),
    "--reasoning",
    "off",
    "--reasoning-format",
    "deepseek",
    "--metrics"
  ];
}

function chatTemplateArgs(chatTemplate: string | undefined): readonly string[] {
  return chatTemplate === undefined ? [] : ["--chat-template-file", chatTemplate];
}

async function waitForModels(
  baseUrl: string,
  modelId: string,
  timeoutMs: number
): Promise<readonly ModelInfo[]> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "server did not respond";
  while (Date.now() < deadline) {
    const models = await probe(baseUrl, 1000);
    if (models?.some((model) => model.id === modelId) === true) {
      return models;
    }
    if (models !== undefined) {
      lastError = `server reported: ${models.map((model) => model.id).join(", ")}`;
    }
    await sleep(500);
  }
  throw new Error(`llama-server did not become ready for ${modelId}: ${lastError}`);
}

async function probe(
  baseUrl: string,
  timeoutMs: number
): Promise<readonly ModelInfo[] | undefined> {
  try {
    return await listModels(baseUrl, timeoutMs);
  } catch {
    return undefined;
  }
}

function metadata(options: LocalpiOptions, model: LlamaServerModel, pid: number): ServerMetadata {
  return {
    pid,
    baseUrl: llamaBaseUrl(options),
    modelId: model.id,
    modelPath: model.modelPath,
    contextWindow: options.contextWindow ?? model.contextWindow ?? 32768,
    serverCommand: options.serverCommand,
    host: options.host,
    port: options.port,
    ...optionalChatTemplate(model.chatTemplate)
  };
}

type ServerMetadata = {
  readonly pid: number;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly modelPath: string;
  readonly contextWindow: number;
  readonly chatTemplate?: string;
  readonly serverCommand: string;
  readonly host: string;
  readonly port: number;
};

async function writeMetadata(options: LocalpiOptions, value: ServerMetadata): Promise<void> {
  await writeFile(metadataPath(options), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readMetadataFile(options: LocalpiOptions): Promise<ServerMetadata | undefined> {
  try {
    return parseMetadata(await readFile(metadataPath(options), "utf8"));
  } catch {
    return undefined;
  }
}

function parseMetadata(raw: string): ServerMetadata {
  const value = JSON.parse(raw) as Partial<ServerMetadata>;
  if (typeof value.pid !== "number" || typeof value.modelId !== "string") {
    throw new Error("invalid llama-server metadata");
  }
  return {
    pid: value.pid,
    baseUrl: metadataString(value.baseUrl),
    modelId: value.modelId,
    modelPath: metadataString(value.modelPath),
    contextWindow: metadataNumber(value.contextWindow),
    serverCommand: metadataString(value.serverCommand),
    host: metadataString(value.host),
    port: metadataNumber(value.port),
    ...optionalChatTemplate(value.chatTemplate)
  };
}

function metadataString(value: string | undefined): string {
  return value ?? "";
}

function metadataNumber(value: number | undefined): number {
  return value ?? 0;
}

function metadataSummary(info: ServerMetadata): string {
  return `pid ${String(info.pid)}, model ${info.modelId}, path ${info.modelPath}`;
}

function metadataPath(options: LocalpiOptions): string {
  return path.join(serverDir(options), "llama-server.json");
}

function serverDir(options: LocalpiOptions): string {
  return path.join(options.stateDir, "server");
}

function isProcessAlive(pid: number): boolean {
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

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await sleep(100);
  }
}

function startupTimeoutMs(): number {
  const raw = process.env["LOCALPI_SERVER_STARTUP_TIMEOUT_MS"];
  return raw === undefined ? 120000 : Number.parseInt(raw, 10);
}

async function lmStudioWarnings(): Promise<readonly string[]> {
  const models = await probe("http://127.0.0.1:1234/v1", 1000);
  if (models === undefined || models.length === 0) {
    return [];
  }
  return [`LM Studio also reports loaded models: ${models.map((model) => model.id).join(", ")}`];
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function optionalContextWindow(contextWindow: number | undefined): {
  readonly contextWindow?: number;
} {
  return contextWindow === undefined ? {} : { contextWindow };
}

function optionalChatTemplate(chatTemplate: string | undefined): {
  readonly chatTemplate?: string;
} {
  return chatTemplate === undefined ? {} : { chatTemplate };
}
