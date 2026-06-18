import { readFile } from "node:fs/promises";
import path from "node:path";

import { asObject, optionalString } from "../common/json.js";
import { parseThinkingLevel, type LocalpiOptions } from "./options.js";

export function thinkingStatePath(options: Pick<LocalpiOptions, "stateDir">): string {
  return path.join(options.stateDir, "thinking.json");
}

export async function applyRememberedThinking(
  options: LocalpiOptions,
  explicitOverride: boolean
): Promise<LocalpiOptions> {
  if (explicitOverride) {
    return options;
  }
  const remembered = await readRememberedThinking(options);
  return remembered === undefined ? options : { ...options, thinking: remembered };
}

async function readRememberedThinking(
  options: Pick<LocalpiOptions, "stateDir">
): Promise<LocalpiOptions["thinking"] | undefined> {
  let raw: string;
  try {
    raw = await readFile(thinkingStatePath(options), "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
  try {
    const root = asObject(JSON.parse(raw) as unknown, "thinking state");
    const thinking = optionalString(root["thinking"]);
    return thinking === undefined ? undefined : parseThinkingLevel(thinking);
  } catch {
    return undefined;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
