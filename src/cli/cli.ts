import { runPiApp } from "@dutifuldev/pi-factory";

import { errorMessage, fail, ok, type CommandResult } from "../common/result.js";
import { parseLocalpiArgs, usage } from "../localpi/options.js";
import {
  aliasListOutput,
  connectionStatus,
  resolveRuntime,
  statusOutput,
  stopRuntime
} from "../localpi/runtime.js";
import { applyRememberedSettings } from "../localpi/settings-state.js";
import { createLocalpiAppDefinition } from "../pi/app.js";
import { writeDefaultExtensions } from "../pi/extensions.js";

export async function run(args: readonly string[]): Promise<CommandResult> {
  try {
    let options = parseLocalpiArgs(args);
    const helpResult = helpCommandResult(options);
    if (helpResult !== undefined) {
      return helpResult;
    }
    validateDemoOptions(options);
    const commandResult = await immediateCommandResult(options);
    if (commandResult !== undefined) {
      return commandResult;
    }
    options = await applyRememberedSettings(options, {
      thinking: hasExplicitThinkingOverride(args)
    });

    const connection = await resolveRuntime(options);
    const selectorOptions = startupModelSelectorOptions(options, connection);
    const extensions = await writeDefaultExtensions(options, {
      ...(selectorOptions === undefined ? {} : { startupModelSelector: selectorOptions })
    });
    const app = createLocalpiAppDefinition(options, connection, extensions);
    return await launchResolvedRuntime(app, connection);
  } catch (error) {
    return fail(`localpi: ${errorMessage(error)}`);
  }
}

type ParsedOptions = ReturnType<typeof parseLocalpiArgs>;

function validateDemoOptions(options: ParsedOptions): void {
  if (!options.demo) {
    return;
  }
  validateExplicitDemoImmediateOptions(options);
  if (!options.demoFromCli && hasImmediateCommand(options)) {
    return;
  }
  validateDemoModel(options);
  validateDemoTty();
  validateForwardedDemoOptions(options.forwardedArgs);
}

function validateForwardedDemoOptions(args: readonly string[]): void {
  const incompatibleMode = forwardedIncompatibleMode(args);
  if (incompatibleMode !== undefined) {
    throw new Error(
      `--demo cannot be used with forwarded Pi mode ${incompatibleMode}; demo mode runs inside Pi TUI`
    );
  }
  const metadataFlag = forwardedMetadataFlag(args);
  if (metadataFlag !== undefined) {
    throw new Error(
      `--demo cannot be used with forwarded Pi metadata flag ${metadataFlag}; run it without --demo`
    );
  }
  const extensionDisableFlag = forwardedExtensionDisableFlag(args);
  if (extensionDisableFlag !== undefined) {
    throw new Error(
      `--demo cannot be used with forwarded Pi extension flag ${extensionDisableFlag}; demo mode requires localpi's generated Pi extension`
    );
  }
  const sessionFlag = forwardedSessionFlag(args);
  if (sessionFlag !== undefined) {
    throw new Error(
      `--demo cannot be used with forwarded Pi session flag ${sessionFlag}; demo mode manages its own session`
    );
  }
  const promptInput = forwardedPromptInput(args);
  if (promptInput !== undefined) {
    throw new Error(
      `--demo cannot be used with forwarded Pi prompt input ${promptInput}; use --demo-initial-prompt or --demo-followup-prompt`
    );
  }
}

function validateDemoModel(options: ParsedOptions): void {
  if (options.model === undefined || options.model === "auto") {
    throw new Error(
      "--demo requires an explicit --model <alias|id|path> or LOCALPI_MODEL value; demo mode will not auto-select a model"
    );
  }
}

function validateDemoTty(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "--demo requires an interactive TTY on stdin and stdout; run it directly in a terminal"
    );
  }
}

function forwardedIncompatibleMode(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--mode") {
      return args[index + 1] ?? "--mode";
    }
    if (arg?.startsWith("--mode=")) {
      return arg.slice("--mode=".length);
    }
  }
  return undefined;
}

function hasImmediateCommand(options: ParsedOptions): boolean {
  return options.status || options.stop || options.list;
}

function validateExplicitDemoImmediateOptions(options: ParsedOptions): void {
  if (!options.demoFromCli) {
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
}

function forwardedPromptInput(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const scan = scanForwardedPromptInput(args, index);
    if (scan.promptInput !== undefined) {
      return scan.promptInput;
    }
    index += scan.consumed - 1;
  }
  return undefined;
}

type ForwardedPromptScan = {
  readonly consumed: number;
  readonly promptInput: string | undefined;
};

function scanForwardedPromptInput(args: readonly string[], index: number): ForwardedPromptScan {
  const arg = args[index];
  if (arg === undefined) {
    return noForwardedPromptInput(1);
  }
  if (isForwardedPromptFlag(arg) || arg.startsWith("@")) {
    return { consumed: 1, promptInput: arg };
  }
  if (isPiValueToken(arg, args[index + 1])) {
    return noForwardedPromptInput(2);
  }
  if (isPiIgnoredToken(arg)) {
    return noForwardedPromptInput(1);
  }
  return arg.startsWith("-") ? noForwardedPromptInput(1) : { consumed: 1, promptInput: arg };
}

function noForwardedPromptInput(consumed: number): ForwardedPromptScan {
  return { consumed, promptInput: undefined };
}

function isForwardedPromptFlag(arg: string): boolean {
  return arg === "-p" || arg === "--print" || arg === "--prompt" || arg.startsWith("--prompt=");
}

function forwardedSessionFlag(args: readonly string[]): string | undefined {
  return args.find((arg) => isForwardedSessionFlag(arg));
}

const forwardedSessionFlags = new Set([
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--session",
  "--session-id",
  "--fork",
  "--no-session"
]);

const forwardedSessionEqualsFlags = [
  "--continue",
  "--resume",
  "--session",
  "--session-id",
  "--fork",
  "--no-session"
] as const;

function isForwardedSessionFlag(arg: string): boolean {
  return (
    forwardedSessionFlags.has(arg) ||
    forwardedSessionEqualsFlags.some((flag) => arg.startsWith(`${flag}=`))
  );
}

function forwardedMetadataFlag(args: readonly string[]): string | undefined {
  return args.find((arg) => isPiMetadataFlag(arg));
}

function forwardedExtensionDisableFlag(args: readonly string[]): string | undefined {
  return args.find((arg) => arg === "--no-extensions" || arg === "-ne");
}

function isPiMetadataFlag(arg: string): boolean {
  return (
    arg === "--help" ||
    arg === "-h" ||
    arg === "--version" ||
    arg === "-v" ||
    arg === "--list-models" ||
    arg === "--export"
  );
}

function isPiValueToken(arg: string, next: string | undefined): boolean {
  return isPiValueFlag(arg) || isPiUnknownLongFlagValue(arg, next);
}

function isPiIgnoredToken(arg: string): boolean {
  return isPiBooleanFlag(arg) || isPiMetadataFlag(arg) || isForwardedSessionFlag(arg);
}

function isPiValueFlag(arg: string): boolean {
  return [
    "--mode",
    "--provider",
    "--model",
    "--api-key",
    "--system-prompt",
    "--append-system-prompt",
    "--name",
    "-n",
    "--session",
    "--session-id",
    "--fork",
    "--session-dir",
    "--models",
    "--tools",
    "-t",
    "--exclude-tools",
    "-xt",
    "--thinking",
    "--export",
    "--extension",
    "-e",
    "--skill",
    "--prompt-template",
    "--theme"
  ].includes(arg);
}

function isPiBooleanFlag(arg: string): boolean {
  return [
    "--no-tools",
    "-nt",
    "--no-builtin-tools",
    "-nbt",
    "--no-extensions",
    "-ne",
    "--no-skills",
    "-ns",
    "--no-prompt-templates",
    "-np",
    "--no-themes",
    "--no-context-files",
    "-nc",
    "--verbose",
    "--approve",
    "-a",
    "--no-approve",
    "-na",
    "--offline"
  ].includes(arg);
}

function isPiUnknownLongFlagValue(arg: string, next: string | undefined): boolean {
  return arg.startsWith("--") && !arg.includes("=") && isPiUnknownLongFlagNextValue(next);
}

function isPiUnknownLongFlagNextValue(arg: string | undefined): boolean {
  return arg !== undefined && !arg.startsWith("-") && !arg.startsWith("@");
}

async function launchResolvedRuntime(
  app: ReturnType<typeof createLocalpiAppDefinition>,
  connection: Awaited<ReturnType<typeof resolveRuntime>>
): Promise<CommandResult> {
  const code = await runPiApp(app);
  if (code !== 0) {
    return { code, stdout: "", stderr: "" };
  }
  return ok(connection.warnings.length === 0 ? "" : connectionStatus(connection));
}

async function immediateCommandResult(options: ParsedOptions): Promise<CommandResult | undefined> {
  if (options.list) {
    return ok(`${await aliasListOutput()}\n`);
  }
  if (options.stop) {
    return ok(`${await stopRuntime(options)}\n`);
  }
  return options.status ? ok(`${await statusOutput(options)}\n`) : undefined;
}

function helpCommandResult(options: ParsedOptions): CommandResult | undefined {
  return options.forwardedArgs.length === 1 && options.forwardedArgs[0] === "--help"
    ? ok(usage())
    : undefined;
}

function hasExplicitThinkingOverride(args: readonly string[]): boolean {
  if (process.env["LOCALPI_THINKING"] !== undefined) {
    return true;
  }
  for (const arg of args) {
    if (arg === "--") {
      return false;
    }
    if (arg === "--thinking") {
      return true;
    }
  }
  return false;
}

function startupModelSelectorOptions(
  options: ParsedOptions,
  connection: Awaited<ReturnType<typeof resolveRuntime>>
): { readonly models: readonly { readonly provider: string; readonly id: string }[] } | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
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
