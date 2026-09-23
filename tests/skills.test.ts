import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureLocalpiSkillsDir, localpiSkillsArgs, localpiSkillsDir } from "../src/pi/skills.js";

describe("localpi skills", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempDir(prefix: string): Promise<string> {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
    cleanup.push(dir);
    return dir;
  }

  it("points at the localpi skills directory", () => {
    expect(localpiSkillsDir("/tmp/state")).toBe(path.join("/tmp/state", "pi-skills"));
  });

  it("creates the skills directory only for the own mode", async () => {
    const stateDir = await tempDir("localpi-skills-");
    const dir = await ensureLocalpiSkillsDir({ skills: "own", stateDir });

    expect(dir).toBe(localpiSkillsDir(stateDir));
    expect((await stat(dir)).isDirectory()).toBe(true);

    const otherState = await tempDir("localpi-skills-other-");
    await ensureLocalpiSkillsDir({ skills: "ambient", stateDir: otherState });
    await expect(stat(localpiSkillsDir(otherState))).rejects.toThrow();
  });

  it("passes the Pi skills arguments for each mode", () => {
    expect(localpiSkillsArgs("own", "/tmp/state")).toEqual([
      "--no-skills",
      "--skill",
      path.join("/tmp/state", "pi-skills")
    ]);
    expect(localpiSkillsArgs("off", "/tmp/state")).toEqual(["--no-skills"]);
    expect(localpiSkillsArgs("ambient", "/tmp/state")).toEqual([]);
  });
});
