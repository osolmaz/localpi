import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { createPiLaunchPlan, shellCommand, writePiRuntimeConfig } from "@osolmaz/pi-factory";
import type { PiAppDefinition, PiLaunchPlan } from "@osolmaz/pi-factory";

/**
 * The ACP mode hands the terminal to the pinned `pi-acp` adapter. The adapter starts Pi itself, so
 * localpi passes its complete Pi launch line through a generated launcher script instead of running
 * Pi directly. That keeps the models file, the settings file, the extensions, the system prompt,
 * and the tool flags of a normal launch.
 */
export type AcpSession = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | undefined;
  readonly launcherPath: string;
  readonly warnings: readonly string[];
};

export type AcpSpawnOptions = {
  readonly stdio: "inherit";
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv;
};

export type AcpHandlers = {
  readonly onError: (error: Error) => void;
  readonly onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
};

export type AcpSpawn = (
  command: string,
  args: readonly string[],
  options: AcpSpawnOptions,
  handlers: AcpHandlers
) => void;

export type AcpRunOptions = {
  readonly diagnostics?: readonly string[];
  readonly spawnProcess?: AcpSpawn;
};

const adapterPackage = "pi-acp";
const adapterEntry = path.join("dist", "index.js");
const localpiPiCommandError =
  "ACP mode cannot start localpi as its Pi command; pass a Pi command with --pi-command or LOCALPI_PI_CMD";

/** The pinned adapter entrypoint inside the installed pi-acp package. */
export function acpAdapterEntrypoint(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["LOCALPI_ACP_ADAPTER"];
  if (override !== undefined && override !== "") {
    return path.resolve(override);
  }
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve(`${adapterPackage}/package.json`);
  return path.join(path.dirname(packagePath), adapterEntry);
}

export async function createAcpSession(app: PiAppDefinition): Promise<AcpSession> {
  const adapterEntrypoint = acpAdapterEntrypoint();
  const runtimeConfig = await writePiRuntimeConfig(app);
  await mkdir(app.sessionDir, { recursive: true });
  const plan = await createPiLaunchPlan(app, runtimeConfig);
  assertPiCommandIsNotLocalpi(plan);
  const launcherPath = await writePiLauncher(app.stateDir, plan);
  return {
    command: process.execPath,
    args: [adapterEntrypoint],
    env: { ...plan.env, PI_ACP_PI_COMMAND: launcherPath, LOCALPI_ACP: "0" },
    cwd: plan.cwd,
    launcherPath,
    warnings: plan.warnings
  };
}

/**
 * Runs the ACP adapter on the current terminal. The adapter owns stdout, because ACP messages are
 * the only bytes an ACP client accepts there. localpi writes its own diagnostics to stderr.
 */
export async function runAcpApp(
  app: PiAppDefinition,
  options: AcpRunOptions = {}
): Promise<number> {
  const session = await createAcpSession(app);
  writeDiagnostics(options.diagnostics ?? []);
  const spawnProcess = options.spawnProcess ?? defaultSpawn;
  return await new Promise<number>((resolve, reject) => {
    spawnProcess(
      session.command,
      session.args,
      {
        stdio: "inherit",
        cwd: session.cwd,
        env: { ...process.env, ...session.env }
      },
      {
        onError: reject,
        onExit: (code, signal) => {
          if (signal !== null) {
            process.kill(process.pid, signal);
            return;
          }
          resolve(code ?? 0);
        }
      }
    );
  });
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: AcpSpawnOptions,
  handlers: AcpHandlers
): void {
  const child = spawn(command, [...args], options);
  child.on("error", handlers.onError);
  child.on("exit", handlers.onExit);
}

function writeDiagnostics(lines: readonly string[]): void {
  for (const line of lines) {
    process.stderr.write(`${line}\n`);
  }
}

async function writePiLauncher(stateDir: string, plan: PiLaunchPlan): Promise<string> {
  const directory = path.join(stateDir, "acp");
  await mkdir(directory, { recursive: true });
  const launcherPath = path.join(directory, launcherFileName(process.platform));
  await writeFile(launcherPath, launcherContents(plan, process.platform));
  await chmod(launcherPath, 0o755);
  return launcherPath;
}

function launcherFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "pi-launcher.cmd" : "pi-launcher.sh";
}

/** The launcher forwards the adapter's own Pi arguments after localpi's launch line. */
export function launcherContents(plan: PiLaunchPlan, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const command = [plan.command, ...plan.args].map(quoteWindowsToken).join(" ");
    return `@echo off\r\n${command} %*\r\n`;
  }
  return `#!/bin/sh\nexec ${shellCommand(plan.command, plan.args)} "$@"\n`;
}

function quoteWindowsToken(token: string): string {
  return `"${token.replace(/"/gu, '""')}"`;
}

/**
 * A Pi command that points back at localpi would re-enter ACP mode inside the adapter. Refuse that
 * before the adapter starts.
 */
function assertPiCommandIsNotLocalpi(plan: PiLaunchPlan): void {
  if (isLocalpiCommand(plan.command) || plan.args.some(isLocalpiCliPath)) {
    throw new Error(localpiPiCommandError);
  }
}

function isLocalpiCommand(program: string): boolean {
  const name = path
    .basename(program)
    .toLowerCase()
    .replace(/\.(js|cjs|mjs|cmd|bat|exe)$/u, "");
  return name === "localpi";
}

function isLocalpiCliPath(token: string): boolean {
  const normalized = token.replaceAll("\\", "/").toLowerCase();
  return /(^|\/)localpi\/(dist\/)?src\/cli\/main\.(js|ts)$/u.test(normalized);
}
