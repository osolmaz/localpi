import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseLocalpiArgs } from "../src/localpi/options.js";
import {
  defaultDemoFollowupPrompt,
  defaultDemoInitialPrompt,
  resolveDemoPrompts
} from "../src/pi/demo.js";

describe("demo prompts", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("uses the built-in story and continue prompts by default", async () => {
    expect(defaultDemoFollowupPrompt).toBe("Continue. Try to write as long as possible.");
    await expect(resolveDemoPrompts(parseLocalpiArgs(["--demo"]))).resolves.toEqual({
      initial: defaultDemoInitialPrompt,
      followup: defaultDemoFollowupPrompt
    });
  });

  it("uses prompt files ahead of text prompts", async () => {
    const dir = await tempDir();
    const initialPath = path.join(dir, "initial.txt");
    const followupPath = path.join(dir, "followup.txt");
    await writeFile(initialPath, "file story");
    await writeFile(followupPath, "file again");

    await expect(
      resolveDemoPrompts(
        parseLocalpiArgs([
          "--demo",
          "--demo-initial-prompt",
          "text story",
          "--demo-followup-prompt",
          "text again",
          "--demo-initial-prompt-file",
          initialPath,
          "--demo-followup-prompt-file",
          followupPath
        ])
      )
    ).resolves.toEqual({
      initial: "file story",
      followup: "file again"
    });
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "localpi-demo-"));
    tempDirs.push(dir);
    return dir;
  }
});
