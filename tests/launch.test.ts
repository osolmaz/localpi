import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";

import { describe, expect, it } from "vitest";

import type { LocalpiOptions } from "../src/localpi/options.js";
import type { RuntimeConnection } from "../src/localpi/runtime.js";
import type { RuntimeConfig } from "../src/pi/config.js";
import { createLaunchPlan, execLaunchPlan, terminateLaunchProcess } from "../src/pi/launch.js";

describe("Pi launch plan", () => {
  it("adds localpi extensions, system prompt, and default tools", async () => {
    const plan = await createLaunchPlan(
      options("/tmp/localpi-state"),
      runtimeConfig("/tmp/localpi-state"),
      connection("gemma-4-e4b-it"),
      {
        paths: ["/tmp/localpi-state/pi-extensions/tool-approval.ts"],
        systemPrompt: "localpi prompt"
      }
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
    const plan = await createLaunchPlan(
      { ...options("/tmp/localpi-state"), forwardedArgs: ["--tools", "bash", "-p", "say ok"] },
      runtimeConfig("/tmp/localpi-state"),
      connection("gemma-4-e4b-it"),
      { paths: [], systemPrompt: "localpi prompt" }
    );

    expect(plan.args).toContain("--tools");
    expect(plan.args.filter((arg) => arg === "--tools")).toHaveLength(1);
    expect(plan.args).toContain("bash");
  });

  it("allows callers to override forwarded Pi args without mutating options", async () => {
    const baseOptions = options("/tmp/localpi-state");
    const plan = await createLaunchPlan(
      baseOptions,
      runtimeConfig("/tmp/localpi-state"),
      connection("gemma-4-e4b-it"),
      { paths: [], systemPrompt: "localpi prompt" },
      { forwardedArgs: ["-p", "demo prompt"] }
    );

    expect(baseOptions.forwardedArgs).toEqual(["-p", "say ok"]);
    expect(plan.args.slice(-2)).toEqual(["-p", "demo prompt"]);
  });

  it("runs the plan through a shell and reports the exit code", async () => {
    await expect(
      execLaunchPlan({ command: "sh -c 'exit 0' --", args: ["quoted 'arg'"], env: {} })
    ).resolves.toBe(0);
    await expect(
      execLaunchPlan({ command: "sh -c 'exit 7' --", args: [], env: { LOCALPI_TEST: "1" } })
    ).resolves.toBe(7);
  });

  it("can pipe input to the launched process", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "localpi-launch-"));
    try {
      const inputPath = path.join(dir, "input.txt");
      const scriptPath = path.join(dir, "stdin.cjs");
      await writeFile(
        scriptPath,
        [
          "const fs = require('node:fs');",
          `const inputPath = ${JSON.stringify(inputPath)};`,
          "let input = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (chunk) => { input += chunk; });",
          "process.stdin.on('end', () => {",
          "  fs.writeFileSync(inputPath, input);",
          "});"
        ].join("\n")
      );

      await expect(
        execLaunchPlan(
          { command: `node ${scriptPath}`, args: [], env: {} },
          { input: "- bullet\n@mention" }
        )
      ).resolves.toBe(0);
      await expect(readFile(inputPath, "utf8")).resolves.toBe("- bullet\n@mention");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("can terminate detached shell command process groups", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "localpi-launch-"));
    try {
      const pidPath = path.join(dir, "child.pid");
      const scriptPath = path.join(dir, "child.cjs");
      await writeFile(
        scriptPath,
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);"
        ].join("\n")
      );
      let launched: Parameters<typeof terminateLaunchProcess>[0] | undefined;
      const running = execLaunchPlan(
        { command: `node ${scriptPath}`, args: [], env: {} },
        {
          detached: true,
          forwardSignals: false,
          onChild: (child) => {
            launched = child;
          }
        }
      );

      const childPid = await waitForPid(pidPath);
      if (launched === undefined) {
        throw new Error("launch child was not reported");
      }
      terminateLaunchProcess(launched, "SIGTERM");
      await expect(running).resolves.toBe(143);
      await waitForDead(childPid);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function options(stateDir: string): LocalpiOptions {
  return {
    runtime: "lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "auto",
    provider: undefined,
    customProviderId: "local-openai",
    providersFile: undefined,
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
    tokenStatus: true,
    demo: false,
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

function runtimeConfig(stateDir: string): RuntimeConfig {
  return {
    configDir: path.join(stateDir, "pi"),
    modelsPath: path.join(stateDir, "pi", "models.json"),
    settingsPath: path.join(stateDir, "pi", "settings.json")
  };
}

async function waitForPid(pidPath: string): Promise<number> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      return Number(await readFile(pidPath, "utf8"));
    } catch {
      await sleep(20);
    }
  }
  throw new Error(`timed out waiting for ${pidPath}`);
}

async function waitForDead(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return;
    }
    await sleep(20);
  }
  throw new Error(`process ${String(pid)} is still alive`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
