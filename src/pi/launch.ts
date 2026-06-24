import { mkdir } from "node:fs/promises";
import { createPiLaunchPlan, execPiLaunchPlan } from "pi-factory";
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
  return await execPiLaunchPlan(plan as PiLaunchPlan);
}
