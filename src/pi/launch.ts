import { spawn } from "node:child_process";
import type { StdioOptions } from "node:child_process";
import { mkdir } from "node:fs/promises";

import type { LocalagentOptions } from "../localagent/options.js";
import type { FinalSchemaRuntime } from "../structured/final-schema.js";
import type { RuntimeConfig } from "./config.js";

export type LaunchPlan = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly finalSchemaOutputPath: string | undefined;
};

export async function createLaunchPlan(
  options: LocalagentOptions,
  runtimeConfig: RuntimeConfig,
  model: string,
  finalSchemaRuntime?: FinalSchemaRuntime
): Promise<LaunchPlan> {
  await mkdir(options.sessionDir, { recursive: true });
  const forwardedArgs =
    finalSchemaRuntime === undefined
      ? [...options.forwardedArgs]
      : structuredOutputArgs(options.forwardedArgs, finalSchemaRuntime);
  return {
    command: options.piCommand,
    args: [
      "--provider",
      options.providerId,
      "--model",
      model,
      "--thinking",
      options.thinking,
      ...forwardedArgs
    ],
    finalSchemaOutputPath: finalSchemaRuntime?.outputPath,
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
  const stdio: StdioOptions =
    plan.finalSchemaOutputPath === undefined ? "inherit" : ["inherit", "pipe", "inherit"];
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

function structuredOutputArgs(
  forwardedArgs: readonly string[],
  runtime: FinalSchemaRuntime
): string[] {
  if (forwardedArgs.includes("--no-tools") || forwardedArgs.includes("-nt")) {
    throw new Error("--final-schema cannot be used with --no-tools");
  }
  if (hasRpcMode(forwardedArgs)) {
    throw new Error("--final-schema cannot be used with --mode rpc");
  }
  if (!hasPrintMode(forwardedArgs)) {
    throw new Error("--final-schema requires Pi print mode (-p or --print)");
  }
  return [
    "--extension",
    runtime.extensionPath,
    "--append-system-prompt",
    runtime.instruction,
    ...ensureFinalJsonToolAllowed(forwardedArgs)
  ];
}

function hasRpcMode(args: readonly string[]): boolean {
  return args.some((arg, index) => arg === "--mode" && args[index + 1] === "rpc");
}

function hasPrintMode(args: readonly string[]): boolean {
  return args.includes("--print") || args.includes("-p");
}

function ensureFinalJsonToolAllowed(args: readonly string[]): string[] {
  const next = [...args];
  for (let index = 0; index < next.length; index += 1) {
    const arg = next[index];
    if (arg !== "--tools" && arg !== "-t") {
      continue;
    }
    const value = next[index + 1];
    if (value === undefined) {
      throw new Error(`${arg} requires a value`);
    }
    const tools = value
      .split(",")
      .map((tool) => tool.trim())
      .filter((tool) => tool.length > 0);
    if (!tools.includes("final_json")) {
      tools.push("final_json");
    }
    next[index + 1] = tools.join(",");
  }
  return next;
}

function shellCommand(command: string, args: readonly string[]): string {
  return [command, ...args.map(shellQuote)].join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
