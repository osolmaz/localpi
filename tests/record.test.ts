import { describe, expect, it } from "vitest";

import type { RunResult, SpawnedHandle } from "../src/localpi/exec.js";
import { runRecordCommand, type RecordDeps } from "../src/localpi/record.js";

describe("localpi record", () => {
  it("fails with a clear message when required tools are missing", async () => {
    const harness = new RecordHarness({ missingTools: ["ghostty", "xdotool"] });
    const result = await runRecordCommand(baseArgs, harness.deps());

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("missing required tools: ghostty, xdotool");
  });

  it("fails when the tmux session does not exist", async () => {
    const harness = new RecordHarness({ sessionExists: false });
    const result = await runRecordCommand(baseArgs, harness.deps());

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('tmux session "wall" does not exist');
  });

  it("launches ghostty with the theme and records the window until it closes", async () => {
    const harness = new RecordHarness({ windowVanishesAfterPolls: 2 });
    const result = await runRecordCommand(
      [...baseArgs, "--font-size", "10", "--columns", "220", "--rows", "60"],
      harness.deps()
    );

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const ghostty = harness.mustHaveSpawned("ghostty");
    expect(ghostty.args[0]).toBe("--gtk-single-instance=false");
    expect(ghostty.args[1]).toBe("--theme=Catppuccin Mocha");
    expect(ghostty.args[2]).toMatch(/^--title=localpi-record-/u);
    expect(ghostty.args).toContain("--font-size=10");
    expect(ghostty.args).toContain("--window-width=220");
    expect(ghostty.args).toContain("--window-height=60");
    const eIndex = ghostty.args.indexOf("-e");
    expect(ghostty.args.slice(eIndex + 1)).toEqual(["tmux", "attach", "-t", "wall"]);
    expect(ghostty.env["DISPLAY"]).toBe(":7");

    const ffmpeg = harness.mustHaveSpawned("ffmpeg");
    // 1281x721 window geometry is shaved to even dimensions for yuv420p.
    expect(ffmpeg.args).toContain("1280x720");
    expect(ffmpeg.args).toContain(":7+64,32");
    expect(ffmpeg.args).toContain("libx264");
    expect(ffmpeg.args.at(-1)).toBe("/tmp/out.mp4");

    expect(result.stdout).toContain("recorded: /tmp/out.mp4");
    expect(result.stdout).toContain("stopped: ghostty window closed");
    expect(harness.killed).toContainEqual({ command: "ffmpeg", signal: "SIGINT" });
    expect(harness.killed).toContainEqual({ command: "ghostty", signal: "SIGTERM" });
  });

  it("stops at the --seconds cap when the window stays open", async () => {
    const harness = new RecordHarness({});
    const result = await runRecordCommand([...baseArgs, "--seconds", "3"], harness.deps());

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("stopped: time limit (3s)");
    expect(harness.killed).toContainEqual({ command: "ffmpeg", signal: "SIGINT" });
  });

  it("fails when the ghostty window never appears", async () => {
    const harness = new RecordHarness({ windowAppears: false });
    const result = await runRecordCommand(baseArgs, harness.deps());

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("timed out waiting for the Ghostty window");
  });

  it("requires --session and --out", async () => {
    const result = await runRecordCommand(["--session", "wall"], new RecordHarness({}).deps());

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--session and --out are required");
  });

  it("prints subcommand help", async () => {
    const result = await runRecordCommand(["--help"], new RecordHarness({}).deps());

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Catppuccin Mocha");
    expect(result.stdout).toContain("--seconds");
  });
});

const baseArgs = ["--session", "wall", "--out", "/tmp/out.mp4", "--display", ":7"];

type HarnessConfig = {
  readonly missingTools?: readonly string[];
  readonly sessionExists?: boolean;
  readonly windowAppears?: boolean;
  readonly windowVanishesAfterPolls?: number;
};

type SpawnedRecord = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
};

class RecordHarness {
  readonly spawned: SpawnedRecord[] = [];
  readonly killed: { command: string; signal: string }[] = [];

  private readonly config: HarnessConfig;
  private clock = 0;
  private existencePolls = 0;

  constructor(config: HarnessConfig) {
    this.config = config;
  }

  mustHaveSpawned(command: string): SpawnedRecord {
    const entry = this.spawned.find((candidate) => candidate.command === command);
    if (entry === undefined) {
      throw new Error(`expected ${command} to have been spawned`);
    }
    return entry;
  }

  deps(): RecordDeps {
    return {
      run: (command, args) => Promise.resolve(this.runResult(command, args)),
      spawn: (command, args, env) => {
        this.spawned.push({ command, args, env });
        return this.handle(command);
      },
      env: {},
      sleep: () => {
        // Virtual time: each sleep advances the clock by one second so the
        // --seconds cap is reached deterministically.
        this.clock += 1000;
        return Promise.resolve();
      },
      now: () => this.clock,
      notify: () => undefined,
      onInterrupt: () => () => undefined
    };
  }

  private handle(command: string): SpawnedHandle {
    return {
      pid: 1234,
      kill: (signal) => {
        this.killed.push({ command, signal });
        return true;
      },
      exited: new Promise<number | null>((resolve) => {
        // ffmpeg/ghostty "exit" as soon as they are killed in tests.
        setTimeout(() => {
          resolve(0);
        }, 0);
      })
    };
  }

  private runResult(command: string, args: readonly string[]): RunResult {
    switch (command) {
      case "which":
        return this.whichResult(args[0] ?? "");
      case "tmux":
        return this.tmuxResult();
      case "xdotool":
        return this.xdotoolResult();
      case "xwininfo":
        return this.xwininfoResult();
      default:
        return result(0);
    }
  }

  private whichResult(tool: string): RunResult {
    const missing = this.config.missingTools ?? [];
    return result(missing.includes(tool) ? 1 : 0);
  }

  private tmuxResult(): RunResult {
    return result((this.config.sessionExists ?? true) ? 0 : 1);
  }

  private xdotoolResult(): RunResult {
    return (this.config.windowAppears ?? true) ? result(0, "777\n") : result(1);
  }

  private xwininfoResult(): RunResult {
    this.existencePolls += 1;
    const vanishAfter = this.config.windowVanishesAfterPolls;
    // The first xwininfo call reads the geometry; later ones are existence
    // polls from the stop loop.
    if (vanishAfter !== undefined && this.existencePolls > vanishAfter) {
      return result(1);
    }
    return result(
      0,
      [
        "xwininfo: Window id: 0x309 (has no name)",
        "  Absolute upper-left X:  64",
        "  Absolute upper-left Y:  32",
        "  Width: 1281",
        "  Height: 721"
      ].join("\n")
    );
  }
}

function result(code: number, stdout = ""): RunResult {
  return { code, stdout, stderr: "" };
}
