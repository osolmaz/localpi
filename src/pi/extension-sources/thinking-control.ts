export function thinkingControlExtensionSource(settingsPath: string): string {
  const settingsPathSource = JSON.stringify(settingsPath);
  return `import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const settingsPath = ${settingsPathSource};

// Pi owns the /thinking command. localpi only remembers a level the user chose.
//
// Pi also changes the level on its own: it forces "off" for a model that cannot think, and it
// adjusts the level when the model changes. Pi sets the new model before it adjusts the level, so
// a level event that arrives with a different model than the last one is such an automatic change.
export default function localpiThinkingControl(pi: ExtensionAPI): void {
  let modelKey: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    modelKey = keyOf(ctx.model);
  });

  pi.on("model_select", (event) => {
    modelKey = keyOf(event.model);
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    const current = keyOf(ctx.model);
    const modelChanged = current !== modelKey;
    modelKey = current;
    if (modelChanged || ctx.model?.reasoning !== true) {
      return;
    }
    await persistThinking(event.level);
  });
}

function keyOf(model: { readonly provider: string; readonly id: string } | undefined): string | undefined {
  return model === undefined ? undefined : \`\${model.provider}/\${model.id}\`;
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
