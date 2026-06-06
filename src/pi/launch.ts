import { spawn } from "node:child_process";
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

export async function createLaunchPlan(
  options: LocalpiOptions,
  runtimeConfig: RuntimeConfig,
  connection: RuntimeConnection,
  extensions: ExtensionBundle
): Promise<LaunchPlan> {
  await mkdir(options.sessionDir, { recursive: true });
  return {
    command: options.piCommand,
    args: [
      "--provider",
      options.providerId,
      "--model",
      connection.model,
      "--thinking",
      options.thinking,
      ...extensionArgs(extensions),
      "--append-system-prompt",
      extensions.systemPrompt,
      ...withDefaultTools(options.forwardedArgs, options.tools)
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

export async function execLaunchPlan(plan: LaunchPlan): Promise<number> {
  const stdio: StdioOptions = "inherit";
  const child = spawn(shellCommand(plan.command, plan.args), {
    shell: true,
    stdio,
    env: { ...process.env, ...plan.env }
  });
  child.stdout?.resume();
  return await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 0);
    });
  });
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
