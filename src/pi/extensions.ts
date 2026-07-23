import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { LocalpiOptions } from "../localpi/options.js";
import { localpiSettingsPath } from "../localpi/settings-state.js";
import { resolveDemoPrompts } from "./demo.js";
import { demoModeExtensionSource } from "./extension-sources/demo-mode.js";
import { startupModelSelectorExtensionSource } from "./extension-sources/startup-model-selector.js";
import { thinkingControlExtensionSource } from "./extension-sources/thinking-control.js";
import { tokenStatusExtensionSource } from "./extension-sources/token-status.js";
import { approvalExtensionSource } from "./extension-sources/tool-approval.js";

export type ExtensionBundle = {
  readonly paths: readonly string[];
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
    paths.push(
      await writeExtension(
        extensionDir,
        "demo-mode.ts",
        demoModeExtensionSource(await resolveDemoPrompts(options))
      )
    );
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
    paths.push(await writeExtension(extensionDir, "token-status.ts", tokenStatusExtensionSource()));
  }
  if (options.diffusionCanvas) {
    paths.push(diffusionCanvasExtensionPath());
  }
  return {
    paths,
    systemPrompt: localpiSystemPrompt(options.approval)
  };
}

// The diffusion canvas widget is maintained as a standalone Pi package in
// this repository (packages/diffusion-canvas), so plain Pi users can install
// it too. localpi loads the packaged extension file directly; the extension
// derives the server URLs from the active model's baseUrl at runtime.
export function diffusionCanvasExtensionPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const relative = path.join("packages", "diffusion-canvas", "extensions", "diffusion-canvas.ts");
  // src/pi/ in the repo, dist/src/pi/ in the build: walk up to the root that
  // contains the package.
  for (let dir = moduleDir; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const candidate = path.join(dir, relative);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("localpi installation is missing packages/diffusion-canvas");
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
