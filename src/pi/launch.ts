import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { StdioOptions } from "node:child_process";
import { mkdir } from "node:fs/promises";

import type { LocalpiOptions } from "../localpi/options.js";
import type { RuntimeConnection } from "../localpi/runtime.js";
import type { ExtensionBundle } from "./extensions.js";
import type { RuntimeConfig } from "./config.js";

export type LaunchPlan = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

export type LaunchPlanOptions = {
  readonly forwardedArgs?: readonly string[];
};

export type LaunchExecutionOptions = {
  readonly detached?: boolean;
  readonly forwardSignals?: boolean;
  readonly onChild?: (child: ChildProcess) => void;
};

export async function createLaunchPlan(
  options: LocalpiOptions,
  runtimeConfig: RuntimeConfig,
  connection: RuntimeConnection,
  extensions: ExtensionBundle,
  launchOptions: LaunchPlanOptions = {}
): Promise<LaunchPlan> {
  await mkdir(options.sessionDir, { recursive: true });
  const forwardedArgs = launchOptions.forwardedArgs ?? options.forwardedArgs;
  return {
    command: options.piCommand,
    args: [
      "--provider",
      connection.providerId,
      "--model",
      connection.model,
      "--thinking",
      options.thinking,
      ...extensionArgs(extensions),
      "--append-system-prompt",
      extensions.systemPrompt,
      ...withDefaultTools(forwardedArgs, options.tools)
    ],
    env: {
      PI_CODING_AGENT_DIR: runtimeConfig.configDir,
      PI_CODING_AGENT_SESSION_DIR: options.sessionDir,
      PI_OFFLINE: process.env["PI_OFFLINE"] ?? "1",
      PI_TELEMETRY: process.env["PI_TELEMETRY"] ?? "0",
      PI_SKIP_VERSION_CHECK: process.env["PI_SKIP_VERSION_CHECK"] ?? "1"
    }
  };
}

export async function execLaunchPlan(
  plan: LaunchPlan,
  options: LaunchExecutionOptions = {}
): Promise<number> {
  const stdio: StdioOptions = "inherit";
  const child = spawn(shellCommand(plan.command, plan.args), {
    shell: true,
    stdio,
    detached: options.detached === true,
    env: { ...process.env, ...plan.env }
  });
  options.onChild?.(child);
  child.stdout?.resume();
  return await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        if (options.forwardSignals !== false) {
          process.kill(process.pid, signal);
          return;
        }
        resolve(signalExitCode(signal));
        return;
      }
      resolve(code ?? 0);
    });
  });
}

export function terminateLaunchProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

function shellCommand(command: string, args: readonly string[]): string {
  return [command, ...args.map(shellQuote)].join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function extensionArgs(extensions: ExtensionBundle): readonly string[] {
  return extensions.paths.flatMap((extensionPath) => ["--extension", extensionPath]);
}

function withDefaultTools(args: readonly string[], tools: string | undefined): readonly string[] {
  if (tools === undefined || hasToolFlag(args)) {
    return args;
  }
  return ["--tools", tools, ...args];
}

function hasToolFlag(args: readonly string[]): boolean {
  return args.some(
    (arg) => arg === "--tools" || arg === "-t" || arg === "--no-tools" || arg === "-nt"
  );
}

function signalExitCode(signal: NodeJS.Signals): number {
  switch (signal) {
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    default:
      return 1;
  }
}
