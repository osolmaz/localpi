import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type { LocalpiOptions } from "../localpi/options.js";
import { localpiSettingsPath } from "../localpi/settings-state.js";
import { resolveDemoPrompts } from "./demo.js";
import { startupModelSelectorExtensionSource } from "./extension-sources/startup-model-selector.js";
import { thinkingControlExtensionSource } from "./extension-sources/thinking-control.js";
import { tokenStatusExtensionSource } from "./extension-sources/token-status.js";
import { approvalExtensionSource } from "./extension-sources/tool-approval.js";

export type ExtensionBundle = {
  readonly paths: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly systemPrompt: string;
};

export type ExtensionOptions = {
  readonly startupModelSelector?: StartupModelSelectorOptions;
};

export type StartupModelSelectorOptions = {
  readonly models: readonly StartupModelSelectorModel[];
};

export type StartupModelSelectorModel = {
  readonly provider: string;
  readonly id: string;
};

export async function writeDefaultExtensions(
  options: LocalpiOptions,
  extensionOptions: ExtensionOptions = {}
): Promise<ExtensionBundle> {
  const extensionDir = path.join(options.stateDir, "pi-extensions");
  await mkdir(extensionDir, { recursive: true });
  const paths: string[] = [];
  let env: Record<string, string> = {};
  if (extensionOptions.startupModelSelector !== undefined) {
    paths.push(
      await writeExtension(
        extensionDir,
        "startup-model-selector.ts",
        startupModelSelectorExtensionSource(extensionOptions.startupModelSelector)
      )
    );
  }
  if (options.demo) {
    paths.push(demoModeExtensionPath());
    const prompts = await resolveDemoPrompts(options);
    env = {
      ...env,
      PI_DEMO_MODE: "1",
      PI_DEMO_INITIAL_PROMPT: prompts.initial,
      PI_DEMO_FOLLOWUP_PROMPT: prompts.followup
    };
  }
  paths.push(
    await writeExtension(
      extensionDir,
      "thinking-control.ts",
      thinkingControlExtensionSource(localpiSettingsPath(options))
    )
  );
  if (options.approval) {
    paths.push(await writeExtension(extensionDir, "tool-approval.ts", approvalExtensionSource()));
  }
  if (options.tokenStatus) {
    paths.push(
      await writeExtension(
        extensionDir,
        "token-status.ts",
        tokenStatusExtensionSource({ includeContext: !options.demo })
      )
    );
  }
  return {
    paths,
    env,
    systemPrompt: localpiSystemPrompt(options.approval)
  };
}

// Demo mode is the shared pi-demo-mode package (a git dependency), loaded
// straight from node_modules and configured through PI_DEMO_* env vars.
export function demoModeExtensionPath(): string {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("pi-demo-mode/package.json");
  return path.join(path.dirname(packageJson), "extensions", "demo-mode.ts");
}

async function writeExtension(extensionDir: string, name: string, source: string): Promise<string> {
  const extensionPath = path.join(extensionDir, name);
  await writeFile(extensionPath, source, "utf8");
  return extensionPath;
}

function localpiSystemPrompt(approval: boolean): string {
  return [
    "You are running through localpi, a local Pi launcher for local models.",
    approval
      ? "Tool calls require user approval. If a tool result says it was blocked, denied, or requires approval, the tool did not run."
      : "Tool approval is disabled for this session.",
    "Do not claim that a blocked tool call ran.",
    "Prefer answering directly when tools are not needed."
  ].join("\n");
}
