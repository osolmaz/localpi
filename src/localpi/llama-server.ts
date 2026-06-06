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
  const existingResult = await handleExistingServer(options, model, baseUrl, warnings);
  if (existingResult.runtime !== undefined) {
    return existingResult.runtime;
  }

  assertSafeToStart(warnings);
  const pid = await startManagedServer(options, model);
  await writeMetadata(options, metadata(options, model, pid));
  const models = await waitForManagedModels(options, baseUrl, model.id);
  return {
    baseUrl,
    model: model.id,
    availableModels: models.map((entry) => entry.id),
    managed: true,
    warnings,
    contextWindow: requestedContextWindow(options, model)
  };
}

type ExistingServerResult = {
  readonly runtime?: LlamaServerRuntime;
};

type ExistingServerState = {
  readonly existing: readonly ModelInfo[] | undefined;
  readonly owned: ManagedLlamaServerMetadata | undefined;
};

async function handleExistingServer(
  options: LocalpiOptions,
  model: LlamaServerModel,
  baseUrl: string,
  warnings: readonly string[]
): Promise<ExistingServerResult> {
  const state = await existingServerState(options, baseUrl);
  if (state.existing === undefined) {
    return {};
  }
  const matchingModel = state.existing.find((entry) => entry.id === model.id);
  if (matchingModel !== undefined) {
    return handleMatchingExistingServer(
      options,
      model,
      baseUrl,
      warnings,
      state.existing,
      state.owned,
      matchingModel
    );
  }
  if (state.owned === undefined) {
    return rejectExternalModelConflict(baseUrl, state.existing, model.id);
  }
  await stopManagedLlamaServer(options);
  return {};
}

async function existingServerState(
  options: LocalpiOptions,
  baseUrl: string
): Promise<ExistingServerState> {
  const owned = await readActiveMetadataFile(options);
  const existing = await getLlamaServerModels(options);
  if (owned !== undefined && shouldStopOwnedBeforeStart(owned, existing, baseUrl)) {
    await stopManagedLlamaServer(options);
    return { existing, owned: undefined };
  }
  return { existing, owned };
}

function shouldStopOwnedBeforeStart(
  owned: ManagedLlamaServerMetadata,
  existing: readonly ModelInfo[] | undefined,
  baseUrl: string
): boolean {
  return existing === undefined || owned.baseUrl !== baseUrl;
}

async function handleMatchingExistingServer(
  options: LocalpiOptions,
  model: LlamaServerModel,
  baseUrl: string,
  warnings: readonly string[],
  existing: readonly ModelInfo[],
  owned: ManagedLlamaServerMetadata | undefined,
  matchingModel: ModelInfo
): Promise<ExistingServerResult> {
  if (owned !== undefined && managedLlamaServerNeedsRestart(options, owned, model)) {
    await stopManagedLlamaServer(options);
    return {};
  }
  assertCompatibleExternalContext(baseUrl, matchingModel, options.contextWindow);
  return {
    runtime: existingModelRuntime(
      model,
      baseUrl,
      existing,
      owned !== undefined,
      warnings,
      owned?.contextWindow ?? matchingModel.contextWindow
    )
  };
}

export async function stopManagedLlamaServer(options: LocalpiOptions): Promise<string> {
  const info = await readActiveMetadataFile(options);
  if (info === undefined) {
    return "no localpi-owned llama-server metadata found";
  }
  if (isProcessAlive(info.pid)) {
    signalProcess(info.pid, "SIGTERM");
    await waitForExit(info.pid, 5000);
  }
  if (isProcessAlive(info.pid)) {
    signalProcess(info.pid, "SIGKILL");
    await waitForExit(info.pid, 2000);
  }
  if (isProcessAlive(info.pid)) {
    throw new Error(`failed to stop localpi-owned llama-server pid ${String(info.pid)}`);
  }
  await rm(metadataPath(options), { force: true });
  return `stopped localpi-owned llama-server pid ${String(info.pid)}`;
}

export async function llamaServerStatus(options: LocalpiOptions): Promise<string> {
  const baseUrl = llamaBaseUrl(options);
  const info = await readActiveMetadataFile(options);
  const models = await getLlamaServerModels(options);
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

export async function getLlamaServerModels(
  options: LocalpiOptions
): Promise<readonly ModelInfo[] | undefined> {
  return probe(llamaBaseUrl(options), options.timeoutMs);
}

export async function isManagedLlamaServerActive(options: LocalpiOptions): Promise<boolean> {
  return (await readActiveMetadataFile(options)) !== undefined;
}

export async function getManagedLlamaServerMetadata(
  options: LocalpiOptions
): Promise<ManagedLlamaServerMetadata | undefined> {
  return readActiveMetadataFile(options);
}

function existingModelRuntime(
  model: LlamaServerModel,
  baseUrl: string,
  existing: readonly ModelInfo[],
  managed: boolean,
  warnings: readonly string[],
  existingContextWindow?: number
): LlamaServerRuntime {
  const ids = existing.map((entry) => entry.id);
  return {
    baseUrl,
    model: model.id,
    availableModels: ids,
    managed,
    warnings,
    ...optionalContextWindow(model.contextWindow ?? existingContextWindow)
  };
}

function rejectExternalModelConflict(
  baseUrl: string,
  existing: readonly ModelInfo[],
  requestedModel: string
): never {
  const ids = existing.map((entry) => entry.id);
  throw new Error(
    `server at ${baseUrl} is already serving ${ids.join(", ")}; stop it or choose that model before starting ${requestedModel}`
  );
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
    const pid = child.pid;
    return await new Promise<number>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(new Error(`failed to start llama-server: ${error.message}; see ${logPath}`));
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(
          new Error(
            `llama-server exited before startup completed (${exitDescription(code, signal)}); see ${logPath}`
          )
        );
      };
      const timer = setTimeout(() => {
        cleanup();
        if (pid === undefined) {
          reject(
            new Error(`failed to start llama-server: process id was unavailable; see ${logPath}`)
          );
          return;
        }
        child.unref();
        resolve(pid);
      }, 250);
      child.once("error", onError);
      child.once("exit", onExit);
    });
  } finally {
    closeSync(logFd);
  }
}

function serverArgs(options: LocalpiOptions, model: LlamaServerModel): readonly string[] {
  const endpoint = managedEndpoint(options);
  return [
    "--host",
    endpoint.host,
    "--port",
    String(endpoint.port),
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

async function waitForManagedModels(
  options: LocalpiOptions,
  baseUrl: string,
  modelId: string
): Promise<readonly ModelInfo[]> {
  try {
    return await waitForModels(baseUrl, modelId, startupTimeoutMs());
  } catch (error) {
    await stopManagedLlamaServer(options);
    throw error;
  }
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
  const endpoint = managedEndpoint(options);
  return {
    pid,
    baseUrl: endpoint.baseUrl,
    modelId: model.id,
    modelPath: model.modelPath,
    contextWindow: requestedContextWindow(options, model),
    serverCommand: options.serverCommand,
    host: endpoint.host,
    port: endpoint.port,
    gpuLayers: options.gpuLayers,
    parallel: options.parallel,
    ...optionalChatTemplate(model.chatTemplate)
  };
}

export type ManagedLlamaServerMetadata = {
  readonly pid: number;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly modelPath: string;
  readonly contextWindow: number;
  readonly chatTemplate?: string;
  readonly serverCommand: string;
  readonly host: string;
  readonly port: number;
  readonly gpuLayers: number;
  readonly parallel: number;
};

type ServerMetadata = ManagedLlamaServerMetadata;

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

async function readActiveMetadataFile(
  options: LocalpiOptions
): Promise<ServerMetadata | undefined> {
  const info = await readMetadataFile(options);
  if (info === undefined) {
    return undefined;
  }
  if (await metadataProcessMatches(info)) {
    return info;
  }
  await rm(metadataPath(options), { force: true });
  return undefined;
}

async function metadataProcessMatches(info: ServerMetadata): Promise<boolean> {
  if (!isProcessAlive(info.pid)) {
    return false;
  }
  try {
    const raw = await readFile(`/proc/${String(info.pid)}/cmdline`, "utf8");
    const command = raw.replaceAll("\u0000", " ");
    return command.includes(info.modelPath) && command.includes("llama-server");
  } catch {
    return false;
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
    gpuLayers: metadataNumber(value.gpuLayers),
    parallel: metadataNumber(value.parallel),
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

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Final liveness checks decide whether a failed signal matters.
  }
}

function requestedContextWindow(options: LocalpiOptions, model: LlamaServerModel): number {
  return options.contextWindow ?? model.contextWindow ?? 32768;
}

export function managedLlamaServerNeedsRestart(
  options: LocalpiOptions,
  info: ManagedLlamaServerMetadata,
  model?: LlamaServerModel
): boolean {
  const endpoint = managedEndpoint(options);
  const fieldsChanged = [
    info.baseUrl !== endpoint.baseUrl,
    info.serverCommand !== options.serverCommand,
    info.host !== endpoint.host,
    info.port !== endpoint.port,
    info.gpuLayers !== options.gpuLayers,
    info.parallel !== options.parallel
  ].some(Boolean);
  return fieldsChanged || chatTemplateChanged(options, info) || modelChanged(options, info, model);
}

function chatTemplateChanged(options: LocalpiOptions, info: ManagedLlamaServerMetadata): boolean {
  return options.chatTemplate !== undefined && info.chatTemplate !== options.chatTemplate;
}

function modelChanged(
  options: LocalpiOptions,
  info: ManagedLlamaServerMetadata,
  model: LlamaServerModel | undefined
): boolean {
  return model === undefined ? false : !managedModelMatches(options, info, model);
}

function managedModelMatches(
  options: LocalpiOptions,
  info: ManagedLlamaServerMetadata,
  model: LlamaServerModel
): boolean {
  return (
    info.modelId === model.id &&
    info.modelPath === model.modelPath &&
    info.contextWindow === requestedContextWindow(options, model) &&
    info.chatTemplate === model.chatTemplate
  );
}

function managedEndpoint(options: LocalpiOptions): {
  readonly baseUrl: string;
  readonly host: string;
  readonly port: number;
} {
  const baseUrl = llamaBaseUrl(options);
  if (options.baseUrl === undefined) {
    return { baseUrl, host: options.host, port: options.port };
  }
  const url = new URL(baseUrl);
  const defaultPort = url.protocol === "https:" ? 443 : 80;
  const port = url.port === "" ? defaultPort : Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`cannot derive llama-server port from --base-url ${baseUrl}`);
  }
  return { baseUrl, host: url.hostname, port };
}

function assertCompatibleExternalContext(
  baseUrl: string,
  model: ModelInfo,
  requestedContextWindow: number | undefined
): void {
  if (
    requestedContextWindow !== undefined &&
    model.contextWindow !== undefined &&
    model.contextWindow !== requestedContextWindow
  ) {
    throw new Error(
      `server at ${baseUrl} reports ${model.id} ctx=${String(model.contextWindow)}, but --ctx ${String(requestedContextWindow)} was requested`
    );
  }
}

function exitDescription(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) {
    return `exit code ${String(code)}`;
  }
  if (signal !== null) {
    return `signal ${signal}`;
  }
  return "exit status unavailable";
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

function assertSafeToStart(warnings: readonly string[]): void {
  if (warnings.length === 0) {
    return;
  }
  throw new Error(`${warnings.join("; ")}; unload LM Studio or use --runtime lmstudio`);
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
