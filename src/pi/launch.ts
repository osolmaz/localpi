import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

import type { LocalagentOptions } from "../localagent/options.js";
import type { RuntimeConfig } from "./config.js";

export type LaunchPlan = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

export async function createLaunchPlan(
  options: LocalagentOptions,
  runtimeConfig: RuntimeConfig,
  model: string
): Promise<LaunchPlan> {
  await mkdir(options.sessionDir, { recursive: true });
  return {
    command: options.piCommand,
    args: [
      "--provider",
      options.providerId,
      "--model",
      model,
      "--thinking",
      options.thinking,
      ...options.forwardedArgs
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
  const child = spawn(shellCommand(plan.command, plan.args), {
    shell: true,
    stdio: "inherit",
    env: { ...process.env, ...plan.env }
  });
  return await new Promise((resolve, reject) => {
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
