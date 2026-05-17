import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LocalagentOptions } from "../localagent/options.js";

export type RuntimeConfig = {
  readonly configDir: string;
  readonly modelsPath: string;
  readonly settingsPath: string;
};

export async function writeRuntimeConfig(
  options: LocalagentOptions,
  model: string
): Promise<RuntimeConfig> {
  const configDir = path.join(options.stateDir, "pi-config-runtime");
  await mkdir(configDir, { recursive: true });
  const modelsPath = path.join(configDir, "models.json");
  const settingsPath = path.join(configDir, "settings.json");
  await writeFile(modelsPath, `${JSON.stringify(modelsConfig(options, model), null, 2)}\n`);
  await writeFile(settingsPath, `${JSON.stringify(settingsConfig(options, model), null, 2)}\n`);
  return { configDir, modelsPath, settingsPath };
}

function modelsConfig(options: LocalagentOptions, model: string): unknown {
  return {
    providers: {
      [options.providerId]: {
        baseUrl: options.baseUrl,
        api: "openai-completions",
        apiKey: "local",
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false
        },
        models: [
          {
            id: model,
            name: `Local model (${model})`,
            reasoning: false,
            input: ["text"],
            contextWindow: options.contextWindow,
            maxTokens: options.maxTokens,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0
            }
          }
        ]
      }
    }
  };
}

function settingsConfig(options: LocalagentOptions, model: string): unknown {
  return {
    defaultProvider: options.providerId,
    defaultModel: model,
    defaultThinkingLevel: options.thinking,
    enableInstallTelemetry: false,
    quietStartup: true
  };
}
