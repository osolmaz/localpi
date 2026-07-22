import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { fail, ok, type CommandResult } from "../common/result.js";
import { errorMessage } from "../common/result.js";
import { runCommand, type CommandRunner } from "./exec.js";

// Native port of the pi-demo-grid launcher: creates a balanced tmux grid of
// concurrent `localpi --demo` panes. Preview by default; `--start` creates
// the session. See `localpi grid --help`.

export type GridDeps = {
  readonly run: CommandRunner;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: () => string;
  readonly now: () => Date;
  readonly availableMemoryGb: () => Promise<number | undefined>;
};

const defaultDeps: GridDeps = {
  run: runCommand,
  env: process.env,
  cwd: () => process.cwd(),
  now: () => new Date(),
  availableMemoryGb: readAvailableMemoryGb
};

type GridPlan = {
  readonly session: string;
  readonly concurrency: number;
  readonly cwd: string;
  readonly command: string;
  readonly attachCommand: string;
  readonly start: boolean;
  readonly restart: boolean;
  readonly maxSafeConcurrency: number;
  readonly allowHighConcurrency: boolean;
  readonly minAvailableGb: number | undefined;
};

export async function runGridCommand(
  args: readonly string[],
  deps: GridDeps = defaultDeps
): Promise<CommandResult> {
  try {
    if (args.includes("-h") || args.includes("--help")) {
      return ok(gridUsage());
    }
    const plan = await buildPlan(args, deps);
    if (!plan.start) {
      return ok(await planText(plan, deps));
    }
    await runPreflight(plan, deps);
    await requireTmux(deps);
    await replaceExistingSession(plan, deps);
    await launchTmuxGrid(plan, deps);
    return ok(
      [
        `tmux session: ${plan.session}`,
        `panes: ${String(plan.concurrency)}`,
        `attach: ${plan.attachCommand}`,
        ""
      ].join("\n")
    );
  } catch (error) {
    return fail(`localpi grid: ${errorMessage(error)}`);
  }
}

export function gridUsage(): string {
  return `${[
    "localpi grid - launch a balanced tmux grid of concurrent demo panes",
    "",
    "usage:",
    "  localpi grid --concurrency <n> [options] [-- command...]",
    "",
    "options:",
    "  --concurrency, -n <n>       number of concurrent demo panes (required)",
    "  --session, -s <name>        tmux session name (default: pi-demo-<timestamp>)",
    "  --cwd <dir>                 working directory for each pane (default: current)",
    "  --command <cmd>             shell command per pane (or pass it after --)",
    "  --start                     actually create the tmux session (default: preview)",
    "  --dry-run                   print the launch plan only (also the default)",
    "  --restart                   replace an existing tmux session with the same name",
    "  --max-safe-concurrency <n>  pane count allowed without --allow-high-concurrency",
    "                              (default: 4 or PI_DEMO_GRID_MAX_SAFE_CONCURRENCY)",
    "  --allow-high-concurrency    allow pane counts above the safe limit",
    "  --min-available-gb <gib>    refuse to launch below this much available RAM",
    "                              (default: PI_DEMO_GRID_MIN_AVAILABLE_GB, if set)",
    "  -h, --help                  show this help",
    "",
    "The per-pane command defaults to `localpi --demo` and must select a model",
    "explicitly (--model <id> or LOCALPI_MODEL). Each pane runs with",
    "LOCALPI_DEMO_INDEX and LOCALPI_DEMO_TOTAL set and tmux's tiled layout keeps",
    "the grid balanced (2x2 for 4 panes, 4x4 for 16).",
    "",
    "examples:",
    "  localpi grid -n 16 --allow-high-concurrency -- localpi --demo --model gemma4-26b",
    "  localpi grid -n 4 --start -- localpi --demo --model gemma-e4b",
    "  localpi record --session pi-demo-... --out demo.mp4   # record the grid"
  ].join("\n")}\n`;
}

type GridArgs = {
  readonly concurrency: number | undefined;
  readonly session: string | undefined;
  readonly cwd: string | undefined;
  readonly command: string | undefined;
  readonly commandArgs: readonly string[];
  readonly restart: boolean;
  readonly start: boolean;
  readonly dryRun: boolean;
  readonly maxSafeConcurrency: number | undefined;
  readonly allowHighConcurrency: boolean;
  readonly minAvailableGb: number | undefined;
};

async function buildPlan(args: readonly string[], deps: GridDeps): Promise<GridPlan> {
  const parsed = parseGridArgs(args);
  if (parsed.concurrency === undefined) {
    throw new Error("--concurrency is required (see localpi grid --help)");
  }
  const command = commandFromArgs(parsed);
  const cwd = path.resolve(parsed.cwd ?? deps.cwd());
  await assertDirectory(cwd);
  const session = parsed.session ?? defaultSessionName(deps.now());
  return {
    session,
    concurrency: parsed.concurrency,
    cwd,
    command,
    attachCommand: `tmux attach -t ${shellQuote(session)}`,
    start: parsed.start && !parsed.dryRun,
    restart: parsed.restart,
    maxSafeConcurrency: parsed.maxSafeConcurrency ?? defaultMaxSafeConcurrency(deps.env),
    allowHighConcurrency: parsed.allowHighConcurrency,
    minAvailableGb: parsed.minAvailableGb ?? defaultMinAvailableGb(deps.env)
  };
}

function parseGridArgs(args: readonly string[]): GridArgs {
  let parsed: GridArgs = {
    concurrency: undefined,
    session: undefined,
    cwd: undefined,
    command: undefined,
    commandArgs: [],
    restart: false,
    start: false,
    dryRun: false,
    maxSafeConcurrency: undefined,
    allowHighConcurrency: false,
    minAvailableGb: undefined
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--") {
      parsed = { ...parsed, commandArgs: args.slice(index + 1) };
      break;
    }
    const flag = parseGridFlag(parsed, arg, args[index + 1]);
    parsed = flag.parsed;
    index += flag.advance;
  }
  return parsed;
}

type GridFlagResult = {
  readonly parsed: GridArgs;
  readonly advance: number;
};

function parseGridFlag(parsed: GridArgs, arg: string, next: string | undefined): GridFlagResult {
  const booleans: Record<string, Partial<GridArgs>> = {
    "--restart": { restart: true },
    "--start": { start: true },
    "--dry-run": { dryRun: true },
    "--allow-high-concurrency": { allowHighConcurrency: true }
  };
  const boolean = booleans[arg];
  if (boolean !== undefined) {
    return { parsed: { ...parsed, ...boolean }, advance: 0 };
  }
  return parseGridValueFlag(parsed, arg, next);
}

function parseGridValueFlag(
  parsed: GridArgs,
  arg: string,
  next: string | undefined
): GridFlagResult {
  const values: Record<string, (value: string) => Partial<GridArgs>> = {
    "--concurrency": (value) => ({ concurrency: parsePositiveInt(arg, value) }),
    "-n": (value) => ({ concurrency: parsePositiveInt(arg, value) }),
    "--session": (value) => ({ session: value }),
    "-s": (value) => ({ session: value }),
    "--cwd": (value) => ({ cwd: value }),
    "--command": (value) => ({ command: value }),
    "--max-safe-concurrency": (value) => ({ maxSafeConcurrency: parsePositiveInt(arg, value) }),
    "--min-available-gb": (value) => ({ minAvailableGb: parsePositiveFloat(arg, value) })
  };
  const apply = values[arg];
  if (apply === undefined) {
    throw new Error(`unknown option ${arg} (see localpi grid --help)`);
  }
  if (next === undefined) {
    throw new Error(`${arg} requires a value`);
  }
  return { parsed: { ...parsed, ...apply(next) }, advance: 1 };
}

function commandFromArgs(parsed: GridArgs): string {
  if (parsed.command !== undefined && parsed.commandArgs.length > 0) {
    throw new Error("use either --command or a positional command after --, not both");
  }
  if (parsed.command !== undefined) {
    return parsed.command;
  }
  if (parsed.commandArgs.length === 0) {
    return "localpi --demo";
  }
  return parsed.commandArgs.map(shellQuote).join(" ");
}

async function runPreflight(plan: GridPlan, deps: GridDeps): Promise<void> {
  if (plan.concurrency > plan.maxSafeConcurrency && !plan.allowHighConcurrency) {
    throw new Error(
      `refusing to launch ${String(plan.concurrency)} panes without ` +
        `--allow-high-concurrency (current safe limit: ${String(plan.maxSafeConcurrency)})`
    );
  }
  if (!hasExplicitModel(plan.command, deps.env)) {
    throw new Error(
      "demo grid launch requires an explicit model: add --model <id> " +
        "or set LOCALPI_MODEL for the command"
    );
  }
  await assertMemoryFloor(plan, deps);
}

async function assertMemoryFloor(plan: GridPlan, deps: GridDeps): Promise<void> {
  if (plan.minAvailableGb === undefined) {
    return;
  }
  const available = await deps.availableMemoryGb();
  if (available === undefined) {
    throw new Error("could not determine available memory for --min-available-gb");
  }
  if (available < plan.minAvailableGb) {
    throw new Error(
      `available memory is ${available.toFixed(1)} GiB, below required ` +
        `${plan.minAvailableGb.toFixed(1)} GiB`
    );
  }
}

export function hasExplicitModel(command: string, env: NodeJS.ProcessEnv): boolean {
  const configured = env["LOCALPI_MODEL"];
  if (configured !== undefined && configured !== "") {
    return true;
  }
  if (command.includes("LOCALPI_MODEL=")) {
    return true;
  }
  const parts = command.split(/\s+/u);
  return parts.includes("--model") || parts.some((part) => part.startsWith("--model="));
}

async function requireTmux(deps: GridDeps): Promise<void> {
  const result = await deps.run("tmux", ["-V"]);
  if (result.code !== 0) {
    throw new Error("tmux is required but was not found on PATH");
  }
}

async function replaceExistingSession(plan: GridPlan, deps: GridDeps): Promise<void> {
  const exists = await deps.run("tmux", ["has-session", "-t", plan.session]);
  if (exists.code !== 0) {
    return;
  }
  if (!plan.restart) {
    throw new Error(
      `tmux session ${JSON.stringify(plan.session)} already exists; pass --restart to replace it`
    );
  }
  await tmux(deps, ["kill-session", "-t", plan.session]);
}

async function launchTmuxGrid(plan: GridPlan, deps: GridDeps): Promise<void> {
  const target = `${plan.session}:0`;
  await tmux(deps, [
    "new-session",
    "-d",
    "-s",
    plan.session,
    "-n",
    "demo",
    "-c",
    plan.cwd,
    paneShellCommand(plan, 1)
  ]);
  await configureTmuxWindow(target, deps);
  for (let index = 2; index <= plan.concurrency; index += 1) {
    await tmux(deps, ["split-window", "-t", target, "-c", plan.cwd, paneShellCommand(plan, index)]);
    await tmux(deps, ["select-layout", "-t", target, "tiled"]);
  }
  await tmux(deps, ["select-layout", "-t", target, "tiled"]);
}

async function configureTmuxWindow(target: string, deps: GridDeps): Promise<void> {
  await tmux(deps, ["set-window-option", "-t", target, "remain-on-exit", "on"]);
  await tmux(deps, ["set-window-option", "-t", target, "automatic-rename", "off"]);
  await tmux(deps, ["set-window-option", "-t", target, "aggressive-resize", "on"]);
  await tmux(deps, ["set-window-option", "-t", target, "pane-border-status", "top"]);
  await tmux(deps, ["set-window-option", "-t", target, "pane-border-format", "#{pane_index}"]);
}

async function tmux(deps: GridDeps, args: readonly string[]): Promise<void> {
  const result = await deps.run("tmux", args);
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw new Error(`tmux ${args[0] ?? ""} failed${detail === "" ? "" : `: ${detail}`}`);
  }
}

function paneShellCommand(plan: GridPlan, index: number): string {
  const label = `[localpi demo ${String(index)}/${String(plan.concurrency)}]`;
  const exports =
    `LOCALPI_DEMO_INDEX=${String(index)} ` + `LOCALPI_DEMO_TOTAL=${String(plan.concurrency)}`;
  return `printf '%s\\n' ${shellQuote(label)}; ${exports} sh -lc ${shellQuote(plan.command)}`;
}

async function planText(plan: GridPlan, deps: GridDeps): Promise<string> {
  const lines = [
    `tmux session: ${plan.session}`,
    `panes: ${String(plan.concurrency)}`,
    `cwd: ${plan.cwd}`,
    `command: ${plan.command}`,
    "layout: tiled",
    "start: no (pass --start to create panes)",
    "high concurrency: " +
      (plan.allowHighConcurrency ? "allowed" : `blocked above ${String(plan.maxSafeConcurrency)}`)
  ];
  const available = await deps.availableMemoryGb();
  if (available !== undefined) {
    lines.push(`available memory: ${available.toFixed(1)} GiB`);
  }
  if (plan.minAvailableGb !== undefined) {
    lines.push(`minimum available memory: ${plan.minAvailableGb.toFixed(1)} GiB`);
  }
  lines.push(`attach: ${plan.attachCommand}`, "");
  return lines.join("\n");
}

export function shellQuote(word: string): string {
  if (word !== "" && /^[\w@%+=:,./-]+$/u.test(word)) {
    return word;
  }
  return `'${word.replaceAll("'", String.raw`'\''`)}'`;
}

function defaultSessionName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp =
    `${String(now.getUTCFullYear())}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `pi-demo-${stamp}`;
}

function defaultMaxSafeConcurrency(env: NodeJS.ProcessEnv): number {
  const value = env["PI_DEMO_GRID_MAX_SAFE_CONCURRENCY"];
  if (value === undefined || value === "") {
    return 4;
  }
  return parsePositiveInt("PI_DEMO_GRID_MAX_SAFE_CONCURRENCY", value);
}

function defaultMinAvailableGb(env: NodeJS.ProcessEnv): number | undefined {
  const value = env["PI_DEMO_GRID_MIN_AVAILABLE_GB"];
  if (value === undefined || value === "") {
    return undefined;
  }
  return parsePositiveFloat("PI_DEMO_GRID_MIN_AVAILABLE_GB", value);
}

async function assertDirectory(dir: string): Promise<void> {
  try {
    const stats = await stat(dir);
    if (!stats.isDirectory()) {
      throw new Error(`--cwd must be an existing directory: ${dir}`);
    }
  } catch {
    throw new Error(`--cwd must be an existing directory: ${dir}`);
  }
}

function parsePositiveInt(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parsePositiveFloat(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return parsed;
}

async function readAvailableMemoryGb(): Promise<number | undefined> {
  try {
    const meminfo = await readFile("/proc/meminfo", "utf8");
    for (const line of meminfo.split("\n")) {
      if (line.startsWith("MemAvailable:")) {
        const parts = line.split(/\s+/u);
        const kib = Number(parts[1]);
        return Number.isFinite(kib) ? kib / 1024 / 1024 : undefined;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
