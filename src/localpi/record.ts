import { fail, ok, errorMessage, type CommandResult } from "../common/result.js";
import {
  runCommand,
  spawnDetached,
  type CommandRunner,
  type DetachedSpawner,
  type SpawnedHandle
} from "./exec.js";

// Records an existing tmux session (usually a `localpi grid` demo wall) by
// opening a themed Ghostty window attached to it and capturing exactly that
// window with ffmpeg's x11grab. X11 only. See `localpi record --help`.

export type RecordDeps = {
  readonly run: CommandRunner;
  readonly spawn: DetachedSpawner;
  readonly env: NodeJS.ProcessEnv;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly notify: (line: string) => void;
  readonly onInterrupt: (handler: () => void) => () => void;
};

const defaultDeps: RecordDeps = {
  run: runCommand,
  spawn: spawnDetached,
  env: process.env,
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  now: () => Date.now(),
  notify: (line) => {
    process.stderr.write(`${line}\n`);
  },
  onInterrupt: (handler) => {
    process.once("SIGINT", handler);
    return () => {
      process.removeListener("SIGINT", handler);
    };
  }
};

const requiredTools = ["tmux", "ghostty", "ffmpeg", "xdotool", "xwininfo"] as const;
// Cold Ghostty starts (snap + software GL) can take 30-60s to map the first
// window.
const windowSearchTimeoutMs = 90_000;
const pollIntervalMs = 500;

export async function runRecordCommand(
  args: readonly string[],
  deps: RecordDeps = defaultDeps
): Promise<CommandResult> {
  try {
    if (args.includes("-h") || args.includes("--help")) {
      return ok(recordUsage());
    }
    const options = parseRecordArgs(args);
    await preflight(options, deps);
    return await record(options, deps);
  } catch (error) {
    return fail(`localpi record: ${errorMessage(error)}`);
  }
}

export function recordUsage(): string {
  return `${[
    "localpi record - record a tmux session in a themed Ghostty window (X11)",
    "",
    "usage:",
    "  localpi record --session <name> --out <file.mp4> [options]",
    "",
    "options:",
    "  --session <name>   existing tmux session to attach and record (required)",
    "  --out <file.mp4>   output video path (required)",
    "  --theme <name>     Ghostty theme (default: Catppuccin Mocha)",
    "  --font-size <n>    Ghostty font size",
    "  --columns <n>      Ghostty window width in terminal cells",
    "  --rows <n>         Ghostty window height in terminal cells",
    "  --seconds <n>      stop recording after this many seconds",
    "  --framerate <n>    capture framerate (default: 30)",
    "  --display <id>     X11 display to use (default: $DISPLAY or :0)",
    "  -h, --help         show this help",
    "",
    "Recording stops when the Ghostty window closes (detach with `ctrl-b d` or",
    "close the window), when --seconds elapses, or on ctrl-c; the mp4 is",
    "finalized cleanly in all cases. Requires tmux, ghostty, ffmpeg, xdotool,",
    "and xwininfo on an X11 desktop.",
    "",
    "examples:",
    "  localpi grid -n 16 --allow-high-concurrency --start -- localpi --demo --model gemma4-26b",
    "  localpi record --session pi-demo-20260722-153000 --out demo.mp4 --seconds 360"
  ].join("\n")}\n`;
}

type RecordOptions = {
  readonly session: string;
  readonly out: string;
  readonly theme: string;
  readonly fontSize: number | undefined;
  readonly columns: number | undefined;
  readonly rows: number | undefined;
  readonly seconds: number | undefined;
  readonly framerate: number;
  readonly display: string | undefined;
};

function parseRecordArgs(args: readonly string[]): RecordOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (!arg?.startsWith("--")) {
      throw new Error(`unknown argument ${arg ?? ""} (see localpi record --help)`);
    }
    if (!recordFlags.has(arg)) {
      throw new Error(`unknown option ${arg} (see localpi record --help)`);
    }
    if (next === undefined) {
      throw new Error(`${arg} requires a value`);
    }
    values.set(arg, next);
    index += 1;
  }
  return recordOptionsFromValues(values);
}

const recordFlags = new Set([
  "--session",
  "--out",
  "--theme",
  "--font-size",
  "--columns",
  "--rows",
  "--seconds",
  "--framerate",
  "--display"
]);

function recordOptionsFromValues(values: Map<string, string>): RecordOptions {
  const session = values.get("--session");
  const out = values.get("--out");
  if (session === undefined || out === undefined) {
    throw new Error("--session and --out are required (see localpi record --help)");
  }
  return {
    session,
    out,
    theme: values.get("--theme") ?? "Catppuccin Mocha",
    fontSize: optionalPositive(values, "--font-size"),
    columns: optionalPositive(values, "--columns"),
    rows: optionalPositive(values, "--rows"),
    seconds: optionalPositive(values, "--seconds"),
    framerate: optionalPositive(values, "--framerate") ?? 30,
    display: values.get("--display")
  };
}

function optionalPositive(values: Map<string, string>, flag: string): number | undefined {
  const value = values.get(flag);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return parsed;
}

async function preflight(options: RecordOptions, deps: RecordDeps): Promise<void> {
  const missing: string[] = [];
  for (const tool of requiredTools) {
    const result = await deps.run("which", [tool]);
    if (result.code !== 0) {
      missing.push(tool);
    }
  }
  if (missing.length > 0) {
    throw new Error(`missing required tools: ${missing.join(", ")}`);
  }
  const session = await deps.run("tmux", ["has-session", "-t", options.session]);
  if (session.code !== 0) {
    throw new Error(
      `tmux session ${JSON.stringify(options.session)} does not exist; ` +
        "start one first (for example with `localpi grid --start`)"
    );
  }
}

async function record(options: RecordOptions, deps: RecordDeps): Promise<CommandResult> {
  const display = options.display ?? displayFromEnv(deps.env);
  const env: NodeJS.ProcessEnv = { ...deps.env, DISPLAY: display };
  const marker = `localpi-record-${String(deps.now())}`;
  const ghostty = deps.spawn("ghostty", ghosttyArgs(options, marker), env);
  deps.notify(`ghostty window opening on ${display} (theme: ${options.theme})`);

  let windowId: string;
  let geometry: WindowGeometry;
  try {
    windowId = await findWindowId(marker, env, deps);
    geometry = await windowGeometry(windowId, env, deps);
  } catch (error) {
    // Do not leave a stray Ghostty window behind when the recording setup
    // fails before ffmpeg starts.
    await terminate(ghostty, deps);
    throw error;
  }
  const ffmpeg = deps.spawn("ffmpeg", ffmpegArgs(options, display, geometry), env);
  deps.notify(
    `recording ${String(geometry.width)}x${String(geometry.height)} at ` +
      `${String(options.framerate)} fps to ${options.out} ` +
      "(close the Ghostty window or press ctrl-c to stop)"
  );

  const outcome = await waitForStop(options, windowId, env, ffmpeg, deps);
  await stopRecording(ffmpeg);
  await terminate(ghostty, deps);
  return ok(
    [
      `recorded: ${options.out}`,
      `duration: ~${String(outcome.elapsedSeconds)}s`,
      `stopped: ${outcome.reason}`,
      ""
    ].join("\n")
  );
}

function displayFromEnv(env: NodeJS.ProcessEnv): string {
  const display = env["DISPLAY"];
  return display === undefined || display === "" ? ":0" : display;
}

function ghosttyArgs(options: RecordOptions, marker: string): string[] {
  // A fresh instance guarantees the theme and title apply even when another
  // Ghostty instance is already running on the display.
  const args = ["--gtk-single-instance=false", `--theme=${options.theme}`, `--title=${marker}`];
  if (options.fontSize !== undefined) {
    args.push(`--font-size=${String(options.fontSize)}`);
  }
  if (options.columns !== undefined) {
    args.push(`--window-width=${String(options.columns)}`);
  }
  if (options.rows !== undefined) {
    args.push(`--window-height=${String(options.rows)}`);
  }
  return [...args, "-e", "tmux", "attach", "-t", options.session];
}

async function findWindowId(
  marker: string,
  env: NodeJS.ProcessEnv,
  deps: RecordDeps
): Promise<string> {
  const deadline = deps.now() + windowSearchTimeoutMs;
  while (deps.now() < deadline) {
    const result = await deps.run("xdotool", ["search", "--name", marker], env);
    const windowId = result.stdout.split("\n")[0]?.trim() ?? "";
    if (result.code === 0 && windowId !== "") {
      return windowId;
    }
    await deps.sleep(pollIntervalMs);
  }
  throw new Error("timed out waiting for the Ghostty window to appear (is the display right?)");
}

type WindowGeometry = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

async function windowGeometry(
  windowId: string,
  env: NodeJS.ProcessEnv,
  deps: RecordDeps
): Promise<WindowGeometry> {
  const result = await deps.run("xwininfo", ["-id", windowId], env);
  if (result.code !== 0) {
    throw new Error(`xwininfo failed for window ${windowId}`);
  }
  const x = xwininfoValue(result.stdout, "Absolute upper-left X");
  const y = xwininfoValue(result.stdout, "Absolute upper-left Y");
  const width = xwininfoValue(result.stdout, "Width");
  const height = xwininfoValue(result.stdout, "Height");
  // libx264 with yuv420p needs even dimensions; shave a pixel when odd.
  return { x, y, width: width - (width % 2), height: height - (height % 2) };
}

function xwininfoValue(output: string, label: string): number {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${label}:`)) {
      const value = Number(trimmed.slice(label.length + 1).trim());
      if (Number.isFinite(value)) {
        return value;
      }
    }
  }
  throw new Error(`could not read ${JSON.stringify(label)} from xwininfo output`);
}

function ffmpegArgs(options: RecordOptions, display: string, geometry: WindowGeometry): string[] {
  return [
    "-y",
    "-f",
    "x11grab",
    "-framerate",
    String(options.framerate),
    "-video_size",
    `${String(geometry.width)}x${String(geometry.height)}`,
    "-draw_mouse",
    "0",
    "-i",
    `${display}+${String(geometry.x)},${String(geometry.y)}`,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    options.out
  ];
}

type StopOutcome = {
  readonly reason: string;
  readonly elapsedSeconds: number;
};

async function waitForStop(
  options: RecordOptions,
  windowId: string,
  env: NodeJS.ProcessEnv,
  ffmpeg: SpawnedHandle,
  deps: RecordDeps
): Promise<StopOutcome> {
  const startedAt = deps.now();
  let ffmpegDone = false;
  let interrupted = false;
  void ffmpeg.exited.then(() => {
    ffmpegDone = true;
  });
  const release = deps.onInterrupt(() => {
    interrupted = true;
  });
  try {
    return await pollForStop(options, windowId, env, deps, {
      startedAt,
      ffmpegDone: () => ffmpegDone,
      interrupted: () => interrupted
    });
  } finally {
    release();
  }
}

type StopSignals = {
  readonly startedAt: number;
  readonly ffmpegDone: () => boolean;
  readonly interrupted: () => boolean;
};

async function pollForStop(
  options: RecordOptions,
  windowId: string,
  env: NodeJS.ProcessEnv,
  deps: RecordDeps,
  signals: StopSignals
): Promise<StopOutcome> {
  for (;;) {
    const elapsedSeconds = Math.round((deps.now() - signals.startedAt) / 1000);
    if (signals.ffmpegDone()) {
      return { reason: "ffmpeg exited", elapsedSeconds };
    }
    if (signals.interrupted()) {
      return { reason: "interrupted", elapsedSeconds };
    }
    if (options.seconds !== undefined && elapsedSeconds >= options.seconds) {
      return { reason: `time limit (${String(options.seconds)}s)`, elapsedSeconds };
    }
    if (!(await windowExists(windowId, env, deps))) {
      return { reason: "ghostty window closed", elapsedSeconds };
    }
    await deps.sleep(pollIntervalMs);
  }
}

async function windowExists(
  windowId: string,
  env: NodeJS.ProcessEnv,
  deps: RecordDeps
): Promise<boolean> {
  const result = await deps.run("xwininfo", ["-id", windowId], env);
  return result.code === 0;
}

async function stopRecording(ffmpeg: SpawnedHandle): Promise<void> {
  ffmpeg.kill("SIGINT");
  await ffmpeg.exited;
}

// Escalates to SIGKILL when the process ignores SIGTERM, so a stubborn
// Ghostty window can never keep the CLI from exiting.
async function terminate(handle: SpawnedHandle, deps: RecordDeps): Promise<void> {
  handle.kill("SIGTERM");
  const outcome = await Promise.race([
    handle.exited.then(() => "exited" as const),
    deps.sleep(5000).then(() => "timeout" as const)
  ]);
  if (outcome === "timeout") {
    handle.kill("SIGKILL");
    await handle.exited;
  }
}
