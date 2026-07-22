import { execFile, spawn } from "node:child_process";

export type RunResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CommandRunner = (
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv
) => Promise<RunResult>;

export type SpawnedHandle = {
  readonly pid: number | undefined;
  kill(signal: NodeJS.Signals): boolean;
  readonly exited: Promise<number | null>;
};

export type DetachedSpawner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
) => SpawnedHandle;

// Runs a command to completion, resolving with its exit code instead of
// rejecting on non-zero exits. A missing executable resolves as code 127 with
// the error message on stderr, so callers can produce their own diagnostics.
export const runCommand: CommandRunner = (command, args, env) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { env: env ?? process.env, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          resolve({ code: 127, stdout, stderr: stderr === "" ? error.message : stderr });
          return;
        }
        resolve({ code: error === null ? 0 : (error.code as number), stdout, stderr });
      }
    );
  });

// Starts a long-lived process without waiting for it; the handle exposes the
// eventual exit code (null when terminated by a signal). The child stays
// ref'd so awaiting `exited` keeps the CLI's event loop alive; callers kill
// every spawned process on all exit paths.
export const spawnDetached: DetachedSpawner = (command, args, env) => {
  const child = spawn(command, args, { env, stdio: "ignore" });
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", () => {
      resolve(null);
    });
    child.once("exit", (code) => {
      resolve(code);
    });
  });
  return {
    pid: child.pid,
    kill: (signal) => child.kill(signal),
    exited
  };
};
