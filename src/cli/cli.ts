import { createInterface } from "node:readline/promises";

import { errorMessage, fail, ok, type CommandResult } from "../common/result.js";
import type { CatalogModel } from "../localpi/catalog.js";
import { parseLocalpiArgs, usage } from "../localpi/options.js";
import {
  aliasListOutput,
  connectionStatus,
  type ModelSelectionRequest,
  resolveRuntime,
  statusOutput,
  stopRuntime
} from "../localpi/runtime.js";
import { writeRuntimeConfig } from "../pi/config.js";
import { writeDefaultExtensions } from "../pi/extensions.js";
import { createLaunchPlan, execLaunchPlan } from "../pi/launch.js";

export async function run(args: readonly string[]): Promise<CommandResult> {
  try {
    const options = parseLocalpiArgs(args);
    const commandResult = await immediateCommandResult(options);
    if (commandResult !== undefined) {
      return commandResult;
    }

    const connection = await resolveRuntime(options, selectModelInteractively);
    const runtimeConfig = await writeRuntimeConfig(options, connection);
    const extensions = await writeDefaultExtensions(options);
    const plan = await createLaunchPlan(options, runtimeConfig, connection, extensions);
    const code = await execLaunchPlan(plan);
    if (code !== 0) {
      return { code, stdout: "", stderr: "" };
    }
    return ok(connection.warnings.length === 0 ? "" : connectionStatus(connection));
  } catch (error) {
    return fail(`localpi: ${errorMessage(error)}`);
  }
}

async function selectModelInteractively(
  request: ModelSelectionRequest
): Promise<CatalogModel | undefined> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return undefined;
  }
  process.stderr.write(
    [
      "Available local models:",
      ...request.models.map((model, index) => `  ${String(index + 1)}. ${model.displayName}`)
    ].join("\n") + "\n"
  );
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const answer = await rl.question(`Choose model [1-${String(request.models.length)}] (1): `);
      const trimmed = answer.trim();
      if (trimmed === "") {
        return request.models[0];
      }
      const index = Number.parseInt(trimmed, 10);
      const model = request.models[index - 1];
      if (Number.isInteger(index) && model !== undefined) {
        return model;
      }
      process.stderr.write(`Enter a number from 1 to ${String(request.models.length)}.\n`);
    }
  } finally {
    rl.close();
  }
}

type ParsedOptions = ReturnType<typeof parseLocalpiArgs>;

async function immediateCommandResult(options: ParsedOptions): Promise<CommandResult | undefined> {
  if (options.forwardedArgs.length === 1 && options.forwardedArgs[0] === "--help") {
    return ok(usage());
  }
  if (options.list) {
    return ok(`${await aliasListOutput()}\n`);
  }
  if (options.stop) {
    return ok(`${await stopRuntime(options)}\n`);
  }
  return options.status ? ok(`${await statusOutput(options)}\n`) : undefined;
}
