import { errorMessage, fail, ok, type CommandResult } from "../common/result.js";
import { parseLocalpiArgs, usage } from "../localpi/options.js";
import {
  aliasListOutput,
  connectionStatus,
  resolveRuntime,
  statusOutput,
  stopRuntime
} from "../localpi/runtime.js";
import { writeRuntimeConfig } from "../pi/config.js";
import { execDemoLoop } from "../pi/demo.js";
import { writeDefaultExtensions } from "../pi/extensions.js";
import { createLaunchPlan, execLaunchPlan } from "../pi/launch.js";

export async function run(args: readonly string[]): Promise<CommandResult> {
  try {
    const options = parseLocalpiArgs(args);
    validateDemoOptions(options);
    const commandResult = await immediateCommandResult(options);
    if (commandResult !== undefined) {
      return commandResult;
    }

    const connection = await resolveRuntime(options);
    const runtimeConfig = await writeRuntimeConfig(options, connection);
    const selectorOptions = startupModelSelectorOptions(options, connection);
    const extensions = await writeDefaultExtensions(
      options,
      selectorOptions === undefined ? {} : { startupModelSelector: selectorOptions }
    );
    return await launchResolvedRuntime(options, runtimeConfig, connection, extensions);
  } catch (error) {
    return fail(`localpi: ${errorMessage(error)}`);
  }
}

type ParsedOptions = ReturnType<typeof parseLocalpiArgs>;

function validateDemoOptions(options: ParsedOptions): void {
  if (!options.demo) {
    return;
  }
  if (options.status) {
    throw new Error("--demo cannot be used with --status");
  }
  if (options.stop) {
    throw new Error("--demo cannot be used with --stop");
  }
  if (options.list) {
    throw new Error("--demo cannot be used with --list");
  }
  const promptFlag = forwardedPromptFlag(options.forwardedArgs);
  if (promptFlag !== undefined) {
    throw new Error(
      `--demo cannot be used with forwarded Pi prompt flag ${promptFlag}; use --demo-initial-prompt or --demo-followup-prompt`
    );
  }
  const sessionFlag = forwardedSessionFlag(options.forwardedArgs);
  if (sessionFlag !== undefined) {
    throw new Error(
      `--demo cannot be used with forwarded Pi session flag ${sessionFlag}; demo mode manages its own session`
    );
  }
}

function forwardedPromptFlag(args: readonly string[]): string | undefined {
  return args.find(
    (arg) => arg === "-p" || arg === "--print" || arg === "--prompt" || arg.startsWith("--prompt=")
  );
}

function forwardedSessionFlag(args: readonly string[]): string | undefined {
  return args.find(
    (arg) =>
      arg === "--continue" ||
      arg === "-c" ||
      arg === "--resume" ||
      arg === "-r" ||
      arg === "--session" ||
      arg === "--session-id" ||
      arg === "--fork" ||
      arg === "--no-session"
  );
}

async function launchResolvedRuntime(
  options: ParsedOptions,
  runtimeConfig: Awaited<ReturnType<typeof writeRuntimeConfig>>,
  connection: Awaited<ReturnType<typeof resolveRuntime>>,
  extensions: Awaited<ReturnType<typeof writeDefaultExtensions>>
): Promise<CommandResult> {
  const code = options.demo
    ? await execDemoLoop(options, runtimeConfig, connection, extensions)
    : await execLaunchPlan(await createLaunchPlan(options, runtimeConfig, connection, extensions));
  if (code !== 0) {
    return { code, stdout: "", stderr: "" };
  }
  return ok(connection.warnings.length === 0 ? "" : connectionStatus(connection));
}

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

function startupModelSelectorOptions(
  options: ParsedOptions,
  connection: Awaited<ReturnType<typeof resolveRuntime>>
): { readonly models: readonly { readonly provider: string; readonly id: string }[] } | undefined {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return undefined;
  }
  if (options.model !== undefined && options.model !== "auto") {
    return undefined;
  }
  const scopedProviderId = options.provider === undefined ? undefined : connection.providerId;
  const loadedModels = connection.catalogModels.filter(
    (model) =>
      model.availability === "loaded" &&
      (scopedProviderId === undefined || model.providerId === scopedProviderId)
  );
  if (loadedModels.length <= 1) {
    return undefined;
  }
  return {
    models: loadedModels.map((model) => ({ provider: model.providerId, id: model.modelId }))
  };
}
