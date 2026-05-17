export type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

export const fail = (stderr: string, code = 2): CommandResult => ({
  code,
  stdout: "",
  stderr: stderr.endsWith("\n") ? stderr : `${stderr}\n`
});

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
