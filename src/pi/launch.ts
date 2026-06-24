import { spawn } from "node:child_process";
import type { StdioOptions } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createPiLaunchPlan } from "pi-factory";
import type { PiLaunchPlan } from "pi-factory";

import type { LocalpiOptions } from "../localpi/options.js";
import type { RuntimeConnection } from "../localpi/runtime.js";
import type { ExtensionBundle } from "./extensions.js";
import type { RuntimeConfig } from "./config.js";
import { createLocalpiAppDefinition } from "./app.js";

export type LaunchPlan = PiLaunchPlan;
type ExecutableLaunchPlan = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
};

export async function createLaunchPlan(
  options: LocalpiOptions,
  runtimeConfig: RuntimeConfig,
  connection: RuntimeConnection,
  extensions: ExtensionBundle
): Promise<LaunchPlan> {
  await mkdir(options.sessionDir, { recursive: true });
  return await createPiLaunchPlan(
    createLocalpiAppDefinition(options, connection, extensions),
    runtimeConfig
  );
}

export async function execLaunchPlan(plan: ExecutableLaunchPlan): Promise<number> {
  const stdio: StdioOptions = "inherit";
  const child = spawn(shellCommand(plan.command, plan.args), {
    shell: true,
    stdio,
    cwd: plan.cwd,
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
