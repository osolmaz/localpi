import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type { LocalpiOptions } from "../localpi/options.js";
import type { EngineEntry } from "../localpi/provider-registry.js";
import { localpiSettingsPath } from "../localpi/settings-state.js";
import { resolveDemoPrompts } from "./demo.js";
import { startupModelSelectorExtensionSource } from "./extension-sources/startup-model-selector.js";
import { statusLineExtensionSource } from "./extension-sources/status-line.js";
import { thinkingControlExtensionSource } from "./extension-sources/thinking-control.js";
import {
  tokenStatusExtensionSource,
  type TokenStatusConfig
} from "./extension-sources/token-status.js";
import { approvalExtensionSource } from "./extension-sources/tool-approval.js";

export type ExtensionBundle = {
  readonly paths: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly systemPrompt: string;
};

export type ExtensionOptions = {
  readonly startupModelSelector?: StartupModelSelectorOptions;
  readonly runtime?: RuntimeStatsTarget;
  readonly engines?: readonly EngineEntry[];
};

export type RuntimeStatsTarget = {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly model: string;
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
  paths.push(
    await writeExtension(
      extensionDir,
      "tool-approval.ts",
      approvalExtensionSource({
        enabled: options.approval,
        settingsPath: localpiSettingsPath(options)
      })
    )
  );
  if (options.stats !== "off") {
    paths.push(
      await writeExtension(
        extensionDir,
        "token-status.ts",
        tokenStatusExtensionSource(tokenStatusConfig(options, extensionOptions.runtime))
      )
    );
    paths.push(
      await writeExtension(
        extensionDir,
        "status-line.ts",
        statusLineExtensionSource({ engines: extensionOptions.engines ?? [] })
      )
    );
  }
  return {
    paths,
    env,
    systemPrompt: localpiSystemPrompt()
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

function tokenStatusConfig(
  options: LocalpiOptions,
  runtime: RuntimeStatsTarget | undefined
): TokenStatusConfig {
  return {
    settingsPath: localpiSettingsPath(options),
    mode: options.stats,
    ...runtimeConfig(runtime)
  };
}

// The managed llama-server and the built-in llama.cpp provider are both llama.cpp, and both
// expose live prefill progress on /slots. Other engines fall back to elapsed-time prefill display.
function runtimeConfig(
  runtime: RuntimeStatsTarget | undefined
): Pick<TokenStatusConfig, "engine" | "baseUrl" | "modelId"> {
  if (runtime === undefined) {
    return {};
  }
  const llamaCpp = runtime.providerId === "llama-cpp" || runtime.providerId === "llama-server";
  return {
    ...(llamaCpp ? { engine: "llama-cpp" as const } : {}),
    baseUrl: runtime.baseUrl,
    modelId: runtime.model
  };
}

// The tool approval gate appends its own detailed rule. This base prompt keeps the same warning
// when a user disables localpi extensions, and stays true whether approval is on or off.
function localpiSystemPrompt(): string {
  return [
    "You are running through localpi, a local Pi launcher for local models.",
    "Tool calls may require user approval. Never claim that a tool call ran when its result says it was blocked or denied.",
    "Prefer answering directly when tools are not needed."
  ].join("\n");
}
