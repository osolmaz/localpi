import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/cli/cli.js";
import {
  acpAdapterEntrypoint,
  createAcpSession,
  launcherContents,
  runAcpApp,
  type AcpSpawn,
  type AcpSpawnOptions
} from "../src/localpi/acp.js";
import { parsePiCommand, type LocalpiOptions } from "../src/localpi/options.js";
import type { RuntimeConnection } from "../src/localpi/runtime.js";
import { createLocalpiAppDefinition } from "../src/pi/app.js";

type RecordedSpawn = {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: AcpSpawnOptions;
};

function recordingSpawn(exitCode: number | null): {
  readonly spawn: AcpSpawn;
  readonly calls: RecordedSpawn[];
} {
  const calls: RecordedSpawn[] = [];
  const spawn: AcpSpawn = (command, args, options, handlers) => {
    calls.push({ command, args, options });
    queueMicrotask(() => {
      handlers.onExit(exitCode, null);
    });
  };
  return { spawn, calls };
}

describe("ACP mode", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function tempStateDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "localpi-acp-"));
    tempDirs.push(dir);
    return dir;
  }

  it("resolves the pinned adapter entrypoint from the installed package", async () => {
    const entrypoint = acpAdapterEntrypoint({});
    expect(entrypoint).toContain(path.join("pi-acp", "dist", "index.js"));
    await expect(access(entrypoint)).resolves.toBeUndefined();
  });

  it("honors the adapter override for a different adapter build", () => {
    expect(acpAdapterEntrypoint({ LOCALPI_ACP_ADAPTER: "/tmp/other-adapter.js" })).toBe(
      "/tmp/other-adapter.js"
    );
  });

  it("writes the same Pi configuration a normal launch writes and points the adapter at a launcher", async () => {
    const stateDir = await tempStateDir();
    const session = await createAcpSession(app(stateDir));

    expect(session.command).toBe(process.execPath);
    expect(session.args).toEqual([acpAdapterEntrypoint()]);
    expect(session.env["PI_ACP_PI_COMMAND"]).toBe(session.launcherPath);
    expect(session.env["LOCALPI_ACP"]).toBe("0");
    expect(session.env["PI_CODING_AGENT_DIR"]).toBe(path.join(stateDir, "pi-config-runtime"));
    await expect(
      access(path.join(stateDir, "pi-config-runtime", "models.json"))
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(stateDir, "pi-config-runtime", "settings.json"))
    ).resolves.toBeUndefined();

    const launcher = await readFile(session.launcherPath, "utf8");
    expect(launcher.startsWith("#!/bin/sh\nexec ")).toBe(true);
    expect(launcher).toContain(
      "'--provider' 'lmstudio' '--model' 'gemma-4-e4b-it' '--thinking' 'off'"
    );
    expect(launcher).toContain("'--extension' '/tmp/localpi-state/pi-extensions/tool-approval.ts'");
    expect(launcher).toContain("'--append-system-prompt' 'localpi prompt'");
    expect(launcher).toContain("'--tools' 'read,bash,edit,write,grep,find,ls'");
    expect(launcher.endsWith('"$@"\n')).toBe(true);
  });

  it("writes a sh launcher that quotes the Pi program and its arguments", () => {
    const contents = launcherContents(
      {
        appId: "localpi",
        appName: "localpi",
        command: "/opt/pi bin/pi",
        args: ["--model", "a b", "--append-system-prompt", "it's here"],
        env: {},
        runtimeConfig: {
          configDir: "/tmp/config",
          modelsPath: "/tmp/config/models.json",
          settingsPath: "/tmp/config/settings.json"
        },
        warnings: []
      },
      "linux"
    );
    expect(contents.startsWith("#!/bin/sh\nexec '/opt/pi bin/pi' '--model' 'a b'")).toBe(true);
    expect(contents).toContain("'--append-system-prompt' 'it'\\''s here'");
    expect(contents.endsWith('"$@"\n')).toBe(true);
  });

  it("writes a cmd launcher that forwards adapter arguments on Windows", () => {
    const contents = launcherContents(
      {
        appId: "localpi",
        appName: "localpi",
        command: "C:\\Pi\\pi.exe",
        args: ["--model", "a b"],
        env: {},
        runtimeConfig: {
          configDir: "/tmp/config",
          modelsPath: "/tmp/config/models.json",
          settingsPath: "/tmp/config/settings.json"
        },
        warnings: []
      },
      "win32"
    );
    expect(contents).toBe('@echo off\r\n"C:\\Pi\\pi.exe" "--model" "a b" %*\r\n');
  });

  it("starts the adapter with inherited stdio and returns its exit code", async () => {
    const stateDir = await tempStateDir();
    const recorder = recordingSpawn(7);
    const code = await runAcpApp(app(stateDir), { spawnProcess: recorder.spawn });

    expect(code).toBe(7);
    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0];
    expect(call?.command).toBe(process.execPath);
    expect(call?.args).toEqual([acpAdapterEntrypoint()]);
    expect(call?.options.stdio).toBe("inherit");
    expect(call?.options.env["PI_ACP_PI_COMMAND"]).toBeDefined();
  });

  it("keeps stdout for the protocol and writes diagnostics to stderr", async () => {
    const stateDir = await tempStateDir();
    const recorder = recordingSpawn(0);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await runAcpApp(app(stateDir), {
        diagnostics: ["localpi: backend warning"],
        spawnProcess: recorder.spawn
      });
      expect(code).toBe(0);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith("localpi: backend warning\n");
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("refuses to start localpi as the adapter's Pi command", async () => {
    const stateDir = await tempStateDir();
    const direct = createLocalpiAppDefinition(
      { ...options(stateDir), piCommand: parsePiCommand("localpi") },
      connection("gemma-4-e4b-it")
    );
    await expect(createAcpSession(direct)).rejects.toThrow(
      "ACP mode cannot start localpi as its Pi command"
    );

    const nested = createLocalpiAppDefinition(
      {
        ...options(stateDir),
        piCommand: parsePiCommand("node /opt/localpi/dist/src/cli/main.js")
      },
      connection("gemma-4-e4b-it")
    );
    await expect(createAcpSession(nested)).rejects.toThrow(
      "ACP mode cannot start localpi as its Pi command"
    );
  });

  it("requires an explicit model before the adapter starts", async () => {
    const missing = await run(["--acp"]);
    expect(missing.code).toBe(2);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("--acp requires an explicit --model");

    const auto = await run(["--acp", "--model", "auto"]);
    expect(auto.code).toBe(2);
    expect(auto.stderr).toContain("--acp requires an explicit --model");
  });

  it("rejects ACP mode with immediate commands and demo mode", async () => {
    for (const flag of ["--status", "--stop", "--list"]) {
      const result = await run(["--acp", "--model", "served-model", flag]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`--acp cannot be used with ${flag}`);
    }
    const demo = await run(["--acp", "--model", "served-model", "--demo"]);
    expect(demo.code).toBe(2);
    expect(demo.stderr).toContain("--acp cannot be used with --demo");
  });

  it("rejects forwarded Pi flags that the adapter owns", async () => {
    const mode = await run(["--acp", "--model", "served-model", "--mode", "json"]);
    expect(mode.code).toBe(2);
    expect(mode.stderr).toContain("--acp cannot be used with forwarded Pi mode json");

    const session = await run(["--acp", "--model", "served-model", "--session", "/tmp/s.json"]);
    expect(session.code).toBe(2);
    expect(session.stderr).toContain(
      "--acp cannot be used with forwarded Pi session flag --session"
    );

    const prompt = await run(["--acp", "--model", "served-model", "-p", "say ok"]);
    expect(prompt.code).toBe(2);
    expect(prompt.stderr).toContain("--acp cannot be used with forwarded Pi prompt input -p");
  });

  it("hands the terminal to the adapter without writing to stdout", async () => {
    const stateDir = await tempStateDir();
    const adapter = path.join(stateDir, "fake-adapter.mjs");
    const record = path.join(stateDir, "adapter.json");
    await writeFile(
      adapter,
      [
        'import { writeFile } from "node:fs/promises";',
        `await writeFile(${JSON.stringify(record)}, JSON.stringify({`,
        "  env: { PI_ACP_PI_COMMAND: process.env.PI_ACP_PI_COMMAND, LOCALPI_ACP: process.env.LOCALPI_ACP }",
        "}));",
        "process.exit(0);"
      ].join("\n")
    );
    const previousAdapter = process.env["LOCALPI_ACP_ADAPTER"];
    process.env["LOCALPI_ACP_ADAPTER"] = adapter;
    try {
      const result = await run([
        "--acp",
        "--model",
        "served-model",
        "--runtime",
        "lmstudio",
        "--base-url",
        await startModelServer("served-model", 4096),
        "--state-dir",
        stateDir,
        "--session-dir",
        path.join(stateDir, "sessions"),
        "--pi-command",
        "true"
      ]);
      expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
      const recorded = JSON.parse(await readFile(record, "utf8")) as {
        readonly env: { readonly PI_ACP_PI_COMMAND?: string; readonly LOCALPI_ACP?: string };
      };
      expect(recorded.env.PI_ACP_PI_COMMAND).toBe(path.join(stateDir, "acp", "pi-launcher.sh"));
      expect(recorded.env.LOCALPI_ACP).toBe("0");
      const launcher = await readFile(recorded.env.PI_ACP_PI_COMMAND ?? "", "utf8");
      expect(launcher).toContain("exec 'true'");
    } finally {
      if (previousAdapter === undefined) {
        delete process.env["LOCALPI_ACP_ADAPTER"];
      } else {
        process.env["LOCALPI_ACP_ADAPTER"] = previousAdapter;
      }
    }
  });
});

async function startModelServer(model: string, contextWindow: number): Promise<string> {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/v1/models"
          ? { data: [{ id: model, context_length: contextWindow }] }
          : { choices: [], usage: {} }
      )
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return `http://127.0.0.1:${String(port)}/v1`;
}

function app(stateDir: string): ReturnType<typeof createLocalpiAppDefinition> {
  return createLocalpiAppDefinition(options(stateDir), connection("gemma-4-e4b-it"), {
    paths: ["/tmp/localpi-state/pi-extensions/tool-approval.ts"],
    env: {},
    systemPrompt: "localpi prompt"
  });
}

function options(stateDir: string): LocalpiOptions {
  return {
    runtime: "lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "local",
    model: "gemma-4-e4b-it",
    provider: undefined,
    customProviderId: "local-openai",
    providersFile: undefined,
    modelProfileFile: undefined,
    modelReasoning: undefined,
    modelThinkingFormat: undefined,
    stateDir,
    sessionDir: path.join(stateDir, "sessions"),
    piCommand: parsePiCommand("pi"),
    thinking: "off",
    thinkingBudget: undefined,
    thinkingBudgetMessage: undefined,
    thinkingPhaseOutputCap: undefined,
    contextWindow: undefined,
    maxTokens: 8192,
    continueOnTruncation: 0,
    timeoutMs: 3000,
    serverCommand: "llama-server",
    host: "127.0.0.1",
    port: 18194,
    gpuLayers: 999,
    parallel: 1,
    chatTemplate: undefined,
    tools: "read,bash,edit,write,grep,find,ls",
    approval: true,
    approveReadTools: false,
    stats: "full",
    skills: "own",
    tuiMode: "fullscreen",
    stopThinkingKey: "ctrl+shift+s",
    stopThinkingDelay: 5,
    demo: false,
    demoFromCli: false,
    demoInitialPrompt: undefined,
    demoInitialPromptFile: undefined,
    demoFollowupPrompt: undefined,
    demoFollowupPromptFile: undefined,
    acp: false,
    acpFromCli: false,
    web: false,
    webPort: 0,
    webOpen: true,
    webHost: "127.0.0.1",
    webAllowedHosts: [],
    webTheme: "latte",
    status: false,
    stop: false,
    list: false,
    forwardedArgs: []
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
