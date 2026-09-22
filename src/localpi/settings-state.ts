import { readFile } from "node:fs/promises";
import path from "node:path";

import { asObject, optionalString } from "../common/json.js";
import {
  parseStatsMode,
  parseThinkingLevel,
  type LocalpiOptions,
  type StatsMode
} from "./options.js";

export type LocalpiSettings = {
  readonly thinking?: LocalpiOptions["thinking"];
  readonly stats?: StatsMode;
};

export function localpiSettingsPath(options: Pick<LocalpiOptions, "stateDir">): string {
  return path.join(options.stateDir, "settings.json");
}

export async function applyRememberedSettings(
  options: LocalpiOptions,
  explicit: { readonly thinking: boolean; readonly stats: boolean }
): Promise<LocalpiOptions> {
  const settings = await readLocalpiSettings(options);
  return {
    ...options,
    thinking:
      explicit.thinking || settings.thinking === undefined ? options.thinking : settings.thinking,
    stats: explicit.stats || settings.stats === undefined ? options.stats : settings.stats
  };
}

async function readLocalpiSettings(
  options: Pick<LocalpiOptions, "stateDir">
): Promise<LocalpiSettings> {
  let raw: string;
  try {
    raw = await readFile(localpiSettingsPath(options), "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return {};
    }
    throw error;
  }
  try {
    const root = asObject(JSON.parse(raw) as unknown, "localpi settings");
    const thinking = optionalString(root["thinking"]);
    const stats = optionalString(root["stats"]);
    return {
      ...(thinking === undefined ? {} : { thinking: parseThinkingLevel(thinking) }),
      ...(stats === undefined ? {} : { stats: parseStatsMode(stats) })
    };
  } catch {
    return {};
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
