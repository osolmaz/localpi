import path from "node:path";

import { createPiLaunchPlan, execPiLaunchPlan } from "@dutifuldev/pi-factory";
import type { PiLaunchPlan, PiRuntimeConfig } from "@dutifuldev/pi-factory";
import { describe, expect, it } from "vitest";

import type { LocalpiOptions } from "../src/localpi/options.js";
import type { RuntimeConnection } from "../src/localpi/runtime.js";
import { createLocalpiAppDefinition } from "../src/pi/app.js";

describe("Pi launch plan", () => {
  it("adds localpi extensions, system prompt, and default tools", async () => {
    const stateDir = "/tmp/localpi-state";
    const plan = await createPiLaunchPlan(
      createLocalpiAppDefinition(options(stateDir), connection("gemma-4-e4b-it"), {
        paths: ["/tmp/localpi-state/pi-extensions/tool-approval.ts"],
        systemPrompt: "localpi prompt"
      }),
      runtimeConfig(stateDir)
    );

    expect(plan.args).toEqual([
      "--provider",
      "lmstudio",
      "--model",
      "gemma-4-e4b-it",
      "--thinking",
      "off",
      "--extension",
      "/tmp/localpi-state/pi-extensions/tool-approval.ts",
      "--append-system-prompt",
      "localpi prompt",
      "--tools",
      "read,bash,edit,write,grep,find,ls",
      "-p",
      "say ok"
    ]);
  });

  it("does not add default tools when the user passes an explicit tool flag", async () => {
    const stateDir = "/tmp/localpi-state";
    const plan = await createPiLaunchPlan(
      createLocalpiAppDefinition(
        { ...options(stateDir), forwardedArgs: ["--tools", "bash", "-p", "say ok"] },
        connection("gemma-4-e4b-it"),
        { paths: [], systemPrompt: "localpi prompt" }
      ),
      runtimeConfig(stateDir)
    );

    expect(plan.args).toContain("--tools");
    expect(plan.args.filter((arg) => arg === "--tools")).toHaveLength(1);
    expect(plan.args).toContain("bash");
  });

  it("loads the localpi theme and selects it before user arguments", async () => {
    const stateDir = "/tmp/localpi-state";
    const themePath = "/tmp/localpi-state/pi-themes/catppuccin-mocha.json";
    const plan = await createPiLaunchPlan(
      createLocalpiAppDefinition(
        options(stateDir),
        connection("gemma-4-e4b-it"),
        { paths: [], systemPrompt: "localpi prompt" },
        themePath
      ),
      runtimeConfig(stateDir)
    );

    expect(plan.args.indexOf("--theme")).toBeGreaterThan(-1);
    expect(plan.args[plan.args.indexOf("--theme") + 1]).toBe(themePath);
    expect(plan.args[plan.args.indexOf("--use-theme") + 1]).toBe("catppuccin-mocha");
    expect(plan.args.indexOf("--use-theme")).toBeLessThan(plan.args.indexOf("-p"));
  });

  it("keeps a forwarded Pi theme choice ahead of the localpi theme", async () => {
    const stateDir = "/tmp/localpi-state";
    const plan = await createPiLaunchPlan(
      createLocalpiAppDefinition(
        {
          ...options(stateDir),
          forwardedArgs: ["--use-theme", "light", "-p", "say ok"]
        },
        connection("gemma-4-e4b-it"),
        { paths: [], systemPrompt: "localpi prompt" },
        "/tmp/localpi-state/pi-themes/catppuccin-mocha.json"
      ),
      runtimeConfig(stateDir)
    );

    expect(plan.args).toContain("--theme");
    expect(plan.args.filter((arg) => arg === "--use-theme")).toHaveLength(1);
    expect(plan.args[plan.args.indexOf("--use-theme") + 1]).toBe("light");
  });

  it("adds no theme arguments when Pi themes are disabled", async () => {
    const stateDir = "/tmp/localpi-state";
    const plan = await createPiLaunchPlan(
      createLocalpiAppDefinition(
        { ...options(stateDir), forwardedArgs: ["--no-themes", "-p", "say ok"] },
        connection("gemma-4-e4b-it"),
        { paths: [], systemPrompt: "localpi prompt" },
        undefined
      ),
      runtimeConfig(stateDir)
    );

    expect(plan.args).not.toContain("--theme");
    expect(plan.args).not.toContain("--use-theme");
  });

  it("executes the pi-factory launch plan and reports the exit code", async () => {
    await expect(
      execPiLaunchPlan(executablePlan({ command: "sh", args: ["-c", "exit 0", "--"] }))
    ).resolves.toBe(0);
    await expect(
      execPiLaunchPlan(executablePlan({ command: "sh", args: ["-c", "exit 7", "--"] }))
    ).resolves.toBe(7);
    await expect(
      execPiLaunchPlan(
        executablePlan({
          command: "sh",
          args: ["-c", 'test "$LOCALPI_TEST" = ok', "--"],
          env: { LOCALPI_TEST: "ok" }
        })
      )
    ).resolves.toBe(0);
  });

  it("preserves shell-style pi command values", async () => {
    await expect(
      execPiLaunchPlan(
        executablePlan({
          command: "LOCALPI_TEST=ok sh -c 'test \"$LOCALPI_TEST\" = ok' --",
          args: []
        })
      )
    ).resolves.toBe(0);
  });
});

function executablePlan(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}): PiLaunchPlan {
  return {
    appId: "localpi",
    appName: "localpi",
    command: input.command,
    args: input.args,
    env: input.env ?? {},
    runtimeConfig: runtimeConfig("/tmp/localpi-state"),
    warnings: []
  };
}

function options(stateDir: string): LocalpiOptions {
  return {
    runtime: "lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "auto",
    provider: undefined,
    customProviderId: "local-openai",
    providersFile: undefined,
    modelProfileFile: undefined,
    modelReasoning: undefined,
    modelThinkingFormat: undefined,
    stateDir,
    sessionDir: path.join(stateDir, "sessions"),
    piCommand: "pi",
    thinking: "off",
    contextWindow: undefined,
    maxTokens: 8192,
    timeoutMs: 1000,
    serverCommand: "llama-server",
    host: "127.0.0.1",
    port: 18194,
    gpuLayers: 999,
    parallel: 1,
    chatTemplate: undefined,
    tools: "read,bash,edit,write,grep,find,ls",
    approval: true,
    stats: "full",
    demo: false,
    demoFromCli: false,
    demoInitialPrompt: undefined,
    demoInitialPromptFile: undefined,
    demoFollowupPrompt: undefined,
    demoFollowupPromptFile: undefined,
    status: false,
    stop: false,
    list: false,
    forwardedArgs: ["-p", "say ok"]
  };
}

function connection(model: string): RuntimeConnection {
  return {
    runtime: "lmstudio",
    providerId: "lmstudio",
    providerName: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    model,
    availableModels: [model],
    catalogModels: [],
    warnings: []
  };
}

function runtimeConfig(stateDir: string): PiRuntimeConfig {
  return {
    configDir: path.join(stateDir, "pi"),
    modelsPath: path.join(stateDir, "pi", "models.json"),
    settingsPath: path.join(stateDir, "pi", "settings.json")
  };
}
