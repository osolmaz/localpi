import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { LocalpiOptions, SkillsMode } from "../localpi/options.js";

// Pi loads skills from shared directories such as ~/.agents/skills. A localpi session keeps its own
// skills instead, so a small local model does not carry skill lists it cannot use.
export function localpiSkillsDir(stateDir: string): string {
  return path.join(stateDir, "pi-skills");
}

export async function ensureLocalpiSkillsDir(
  options: Pick<LocalpiOptions, "skills" | "stateDir">
): Promise<string> {
  const dir = localpiSkillsDir(options.stateDir);
  if (options.skills === "own") {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

export function localpiSkillsArgs(mode: SkillsMode, stateDir: string): readonly string[] {
  switch (mode) {
    case "ambient":
      return [];
    case "off":
      return ["--no-skills"];
    case "own":
      return ["--no-skills", "--skill", localpiSkillsDir(stateDir)];
  }
}
