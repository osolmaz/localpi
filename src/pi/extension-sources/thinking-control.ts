export function thinkingControlExtensionSource(settingsPath: string): string {
  const settingsPathSource = JSON.stringify(settingsPath);
  return `import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const settingsPath = ${settingsPathSource};

// Pi owns the /thinking command. localpi only remembers the level Pi selected.
export default function localpiThinkingControl(pi: ExtensionAPI): void {
  pi.on("thinking_level_select", async (event) => {
    await persistThinking(event.level);
  });

  pi.on("session_shutdown", async () => {
    await persistThinking(pi.getThinkingLevel());
  });
}

async function persistThinking(level: string): Promise<void> {
  const settings = await readSettings();
  settings.thinking = level;
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, \`\${JSON.stringify(settings, null, 2)}\\n\`, "utf8");
}

async function readSettings(): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(settingsPath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
`;
}
