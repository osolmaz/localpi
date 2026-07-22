import { describe, expect, it } from "vitest";

import { runGridCommand, type GridDeps } from "../src/localpi/grid.js";

describe("localpi grid", () => {
  it("prints a launch plan without touching tmux by default", async () => {
    const calls: string[][] = [];
    const result = await runGridCommand(
      ["--concurrency", "4", "--session", "wall", "--", "localpi", "--demo", "--model", "gemma"],
      deps({ calls })
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("tmux session: wall");
    expect(result.stdout).toContain("panes: 4");
    expect(result.stdout).toContain("command: localpi --demo --model gemma");
    expect(result.stdout).toContain("layout: tiled");
    expect(result.stdout).toContain("start: no (pass --start to create panes)");
    expect(result.stdout).toContain("available memory: 48.0 GiB");
    expect(result.stdout).toContain("attach: tmux attach -t wall");
    expect(calls).toHaveLength(0);
  });

  it("creates the session, panes, and tiled layout on --start", async () => {
    const calls: string[][] = [];
    const result = await runGridCommand(
      [
        "--concurrency",
        "3",
        "--session",
        "wall",
        "--cwd",
        "/tmp",
        "--start",
        "--",
        "localpi",
        "--demo",
        "--model",
        "gemma"
      ],
      deps({ calls })
    );

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(calls[0]).toEqual(["has-session", "-t", "wall"]);
    expect(calls[1]?.slice(0, 8)).toEqual([
      "new-session",
      "-d",
      "-s",
      "wall",
      "-n",
      "demo",
      "-c",
      "/tmp"
    ]);
    expect(calls[1]?.[8]).toContain("LOCALPI_DEMO_INDEX=1 LOCALPI_DEMO_TOTAL=3");
    expect(calls[1]?.[8]).toContain("[localpi demo 1/3]");
    expect(calls[1]?.[8]).toContain("sh -lc 'localpi --demo --model gemma'");
    const windowOptions = calls.filter((call) => call[0] === "set-window-option");
    expect(windowOptions.map((call) => call[3])).toEqual([
      "remain-on-exit",
      "automatic-rename",
      "aggressive-resize",
      "pane-border-status",
      "pane-border-format"
    ]);
    const splits = calls.filter((call) => call[0] === "split-window");
    expect(splits).toHaveLength(2);
    expect(splits[1]?.[5]).toContain("LOCALPI_DEMO_INDEX=3 LOCALPI_DEMO_TOTAL=3");
    const layouts = calls.filter((call) => call[0] === "select-layout");
    expect(layouts).toHaveLength(3);
    expect(layouts.every((call) => call[3] === "tiled")).toBe(true);
    expect(result.stdout).toContain("tmux session: wall");
    expect(result.stdout).toContain("attach: tmux attach -t wall");
  });

  it("refuses high concurrency without --allow-high-concurrency", async () => {
    const calls: string[][] = [];
    const result = await runGridCommand(
      ["--concurrency", "5", "--start", "--", "localpi", "--demo", "--model", "gemma"],
      deps({ calls })
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("refusing to launch 5 panes");
    expect(result.stderr).toContain("current safe limit: 4");
    expect(calls).toHaveLength(0);
  });

  it("honors PI_DEMO_GRID_MAX_SAFE_CONCURRENCY for the safe limit", async () => {
    const result = await runGridCommand(
      ["--concurrency", "5", "--start", "--", "localpi", "--demo", "--model", "gemma"],
      deps({ env: { PI_DEMO_GRID_MAX_SAFE_CONCURRENCY: "8" } })
    );

    expect(result.code).toBe(0);
  });

  it("requires an explicit model in the pane command", async () => {
    const result = await runGridCommand(["--concurrency", "2", "--start"], deps({}));

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("requires an explicit model");
  });

  it("accepts LOCALPI_MODEL from the environment as the model", async () => {
    const result = await runGridCommand(
      ["--concurrency", "2", "--start"],
      deps({ env: { LOCALPI_MODEL: "gemma" } })
    );

    expect(result.code).toBe(0);
  });

  it("enforces the minimum available memory floor", async () => {
    const result = await runGridCommand(
      [
        "--concurrency",
        "2",
        "--min-available-gb",
        "64",
        "--start",
        "--",
        "localpi",
        "--demo",
        "--model",
        "gemma"
      ],
      deps({ availableGb: 48 })
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("available memory is 48.0 GiB, below required 64.0 GiB");
  });

  it("refuses to replace an existing session without --restart", async () => {
    const result = await runGridCommand(
      ["--concurrency", "2", "--session", "wall", "--start", "--command", "localpi --model g"],
      deps({ existingSessions: ["wall"] })
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("already exists; pass --restart to replace it");
  });

  it("kills and replaces an existing session with --restart", async () => {
    const calls: string[][] = [];
    const result = await runGridCommand(
      [
        "--concurrency",
        "2",
        "--session",
        "wall",
        "--start",
        "--restart",
        "--command",
        "localpi --model g"
      ],
      deps({ calls, existingSessions: ["wall"] })
    );

    expect(result.code).toBe(0);
    expect(calls[1]).toEqual(["kill-session", "-t", "wall"]);
  });

  it("rejects using both --command and a positional command", async () => {
    const result = await runGridCommand(
      ["--concurrency", "2", "--command", "a", "--", "b"],
      deps({})
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not both");
  });

  it("defaults the session name from the current UTC time", async () => {
    const result = await runGridCommand(
      ["--concurrency", "2", "--", "localpi", "--model", "g"],
      deps({})
    );

    expect(result.stdout).toContain("tmux session: pi-demo-20260722-120000");
  });

  it("quotes pane command words that need shell quoting", async () => {
    const calls: string[][] = [];
    await runGridCommand(
      [
        "--concurrency",
        "1",
        "--session",
        "wall",
        "--start",
        "--",
        "localpi",
        "--model",
        "g",
        "say hello"
      ],
      deps({ calls })
    );

    // The joined pane command quotes "say hello"; that quote is then escaped
    // again when the whole command is wrapped for `sh -lc '...'`.
    const pane = calls.find((call) => call[0] === "new-session")?.at(-1) ?? "";
    expect(pane).toContain(String.raw`localpi --model g '\''say hello'\''`);
  });

  it("prints subcommand help", async () => {
    const result = await runGridCommand(["--help"], deps({}));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("localpi grid --concurrency <n>");
    expect(result.stdout).toContain("--allow-high-concurrency");
  });
});

type DepsOverrides = {
  readonly calls?: string[][];
  readonly env?: NodeJS.ProcessEnv;
  readonly availableGb?: number;
  readonly existingSessions?: readonly string[];
};

function deps(overrides: DepsOverrides): GridDeps {
  const calls = overrides.calls ?? [];
  const existing = overrides.existingSessions ?? [];
  return {
    run: (command, args) => {
      expect(command).toBe("tmux");
      if (args[0] === "-V") {
        return Promise.resolve({ code: 0, stdout: "tmux 3.4", stderr: "" });
      }
      if (args[0] === "has-session") {
        calls.push([...args]);
        const code = existing.includes(args[2] ?? "") ? 0 : 1;
        return Promise.resolve({ code, stdout: "", stderr: "" });
      }
      calls.push([...args]);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    env: overrides.env ?? {},
    cwd: () => "/tmp",
    now: () => new Date(Date.UTC(2026, 6, 22, 12, 0, 0)),
    availableMemoryGb: () => Promise.resolve(overrides.availableGb ?? 48)
  };
}
