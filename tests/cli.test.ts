import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { run } from "../src/cli/cli.js";

describe("localpi cli", () => {
  const servers: ReturnType<typeof createServer>[] = [];
  const tempDirs: string[] = [];
  const previousModelsFile = process.env["LOCALPI_MODELS_FILE"];
  const previousDemo = process.env["LOCALPI_DEMO"];
  const previousThinking = process.env["LOCALPI_THINKING"];
  const previousStdinIsTty = process.stdin.isTTY;
  const previousStdoutIsTty = process.stdout.isTTY;

  afterEach(async () => {
    setTty("stdin", previousStdinIsTty);
    setTty("stdout", previousStdoutIsTty);
    if (previousModelsFile === undefined) {
      delete process.env["LOCALPI_MODELS_FILE"];
    } else {
      process.env["LOCALPI_MODELS_FILE"] = previousModelsFile;
    }
    if (previousDemo === undefined) {
      delete process.env["LOCALPI_DEMO"];
    } else {
      process.env["LOCALPI_DEMO"] = previousDemo;
    }
    if (previousThinking === undefined) {
      delete process.env["LOCALPI_THINKING"];
    } else {
      process.env["LOCALPI_THINKING"] = previousThinking;
    }
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          })
      )
    );
    servers.length = 0;
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("prints usage for --help", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("localpi [localpi options] [pi options/messages]");
    expect(result.stderr).toBe("");
  });

  it("prints usage for --help even when demo mode is enabled", async () => {
    const result = await run(["--demo", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("localpi [localpi options] [pi options/messages]");
    expect(result.stderr).toBe("");

    process.env["LOCALPI_DEMO"] = "true";
    const envResult = await run(["--help"]);
    expect(envResult.code).toBe(0);
    expect(envResult.stdout).toContain("localpi [localpi options] [pi options/messages]");
    expect(envResult.stderr).toBe("");
  });

  it("lists configured and built-in aliases for --list", async () => {
    const stateDir = await tempStateDir();
    const configPath = path.join(stateDir, "models.json");
    await writeFile(
      configPath,
      JSON.stringify({ models: { custom: { id: "custom-id", path: "/missing/custom.gguf" } } })
    );
    process.env["LOCALPI_MODELS_FILE"] = configPath;

    const result = await run(["--list"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("custom: id=custom-id\n  /missing/custom.gguf");
    expect(result.stdout).toContain("gemma-12b: id=gemma-4-12b-it ctx=32768");
  });

  it("reports externally managed runtimes for --stop", async () => {
    const result = await run(["--stop", "--runtime", "lmstudio"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("runtime lmstudio is externally managed; nothing stopped\n");
  });

  it("reports missing managed metadata for --stop", async () => {
    const stateDir = await tempStateDir();
    const result = await run(["--stop", "--state-dir", stateDir]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("no localpi-owned llama-server metadata found\n");
  });

  it("prints catalog status for externally managed runtimes", async () => {
    const baseUrl = await startModelServer("served-model", 4096);
    const result = await run(["--status", "--runtime", "lmstudio", "--base-url", baseUrl]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("runtime: lmstudio");
    expect(result.stdout).toContain("loaded models: lmstudio/served-model");
    expect(result.stdout).toContain("startable models: none");
  });

  it("prints llama-server status and aliases for --status", async () => {
    const stateDir = await tempStateDir();
    const baseUrl = await unusedBaseUrl();
    const result = await run([
      "--status",
      "--runtime",
      "llama-server",
      "--state-dir",
      stateDir,
      "--base-url",
      baseUrl,
      "--timeout-ms",
      "200"
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("runtime: llama-server");
    expect(result.stdout).toContain("metadata: none");
    expect(result.stdout).toContain("server: not responding");
    expect(result.stdout).toContain("gemma-12b: id=gemma-4-12b-it");
  });

  it("reports failures as localpi errors with exit code 2", async () => {
    const result = await run(["--runtime", "bogus"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("localpi: unknown runtime bogus");
  });

  it("rejects demo mode with immediate localpi commands", async () => {
    const status = await run(["--demo", "--status"]);
    expect(status.code).toBe(2);
    expect(status.stdout).toBe("");
    expect(status.stderr).toContain("--demo cannot be used with --status");

    const stop = await run(["--demo", "--stop"]);
    expect(stop.code).toBe(2);
    expect(stop.stdout).toBe("");
    expect(stop.stderr).toContain("--demo cannot be used with --stop");

    const list = await run(["--demo", "--list"]);
    expect(list.code).toBe(2);
    expect(list.stdout).toBe("");
    expect(list.stderr).toContain("--demo cannot be used with --list");
  });

  it("lets immediate localpi commands override demo mode from the environment", async () => {
    process.env["LOCALPI_DEMO"] = "true";
    const result = await run(["--stop", "--runtime", "lmstudio"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("runtime lmstudio is externally managed; nothing stopped\n");
    expect(result.stderr).toBe("");
  });

  it("requires an explicit model in demo mode", async () => {
    const missing = await run(["--demo"]);
    expect(missing.code).toBe(2);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain(
      "--demo requires an explicit --model <alias|id|path> or LOCALPI_MODEL value"
    );

    const auto = await run(["--demo", "--model", "auto"]);
    expect(auto.code).toBe(2);
    expect(auto.stdout).toBe("");
    expect(auto.stderr).toContain(
      "--demo requires an explicit --model <alias|id|path> or LOCALPI_MODEL value"
    );
  });

  it("rejects forwarded Pi prompt inputs in demo mode", async () => {
    setTty("stdin", true);
    setTty("stdout", true);

    const result = await run(["--demo", "--model", "served-model", "-p", "say ok"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--demo cannot be used with forwarded Pi prompt input -p");

    const print = await run(["--demo", "--model", "served-model", "--print", "say ok"]);
    expect(print.code).toBe(2);
    expect(print.stdout).toBe("");
    expect(print.stderr).toContain("--demo cannot be used with forwarded Pi prompt input --print");

    const bareMessage = await run(["--demo", "--model", "served-model", "say ok"]);
    expect(bareMessage.code).toBe(2);
    expect(bareMessage.stdout).toBe("");
    expect(bareMessage.stderr).toContain(
      "--demo cannot be used with forwarded Pi prompt input say ok"
    );

    const fileArg = await run(["--demo", "--model", "served-model", "@prompt.md"]);
    expect(fileArg.code).toBe(2);
    expect(fileArg.stdout).toBe("");
    expect(fileArg.stderr).toContain(
      "--demo cannot be used with forwarded Pi prompt input @prompt.md"
    );
  });

  it("rejects forwarded Pi mode overrides in demo mode", async () => {
    setTty("stdin", true);
    setTty("stdout", true);

    const result = await run(["--demo", "--model", "served-model", "--mode", "rpc"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "--demo cannot be used with forwarded Pi mode rpc; demo mode runs inside Pi TUI"
    );

    const equals = await run(["--demo", "--model", "served-model", "--mode=json"]);
    expect(equals.code).toBe(2);
    expect(equals.stdout).toBe("");
    expect(equals.stderr).toContain(
      "--demo cannot be used with forwarded Pi mode json; demo mode runs inside Pi TUI"
    );
  });

  it("rejects forwarded Pi session flags in demo mode", async () => {
    setTty("stdin", true);
    setTty("stdout", true);

    const result = await run([
      "--demo",
      "--model",
      "served-model",
      "--session-id",
      "manual-session"
    ]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "--demo cannot be used with forwarded Pi session flag --session-id"
    );

    const equals = await run(["--demo", "--model", "served-model", "--session-id=manual-session"]);
    expect(equals.code).toBe(2);
    expect(equals.stdout).toBe("");
    expect(equals.stderr).toContain(
      "--demo cannot be used with forwarded Pi session flag --session-id=manual-session"
    );
  });

  it("rejects forwarded Pi metadata commands in demo mode", async () => {
    setTty("stdin", true);
    setTty("stdout", true);

    const listModels = await run(["--demo", "--model", "served-model", "--list-models"]);
    expect(listModels.code).toBe(2);
    expect(listModels.stdout).toBe("");
    expect(listModels.stderr).toContain(
      "--demo cannot be used with forwarded Pi metadata flag --list-models"
    );

    const exportSession = await run([
      "--demo",
      "--model",
      "served-model",
      "--export",
      "session.html"
    ]);
    expect(exportSession.code).toBe(2);
    expect(exportSession.stdout).toBe("");
    expect(exportSession.stderr).toContain(
      "--demo cannot be used with forwarded Pi metadata flag --export"
    );
  });

  it("rejects forwarded Pi extension disabling in demo mode", async () => {
    setTty("stdin", true);
    setTty("stdout", true);

    const result = await run(["--demo", "--model", "served-model", "--no-extensions"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "--demo cannot be used with forwarded Pi extension flag --no-extensions"
    );

    const short = await run(["--demo", "--model", "served-model", "-ne"]);
    expect(short.code).toBe(2);
    expect(short.stdout).toBe("");
    expect(short.stderr).toContain("--demo cannot be used with forwarded Pi extension flag -ne");
  });

  it("launches pi against the resolved runtime and writes its config", async () => {
    const stateDir = await tempStateDir();
    const baseUrl = await startModelServer("served-model", 4096);
    const result = await run([
      "--runtime",
      "lmstudio",
      "--base-url",
      baseUrl,
      "--state-dir",
      stateDir,
      "--session-dir",
      path.join(stateDir, "sessions"),
      "--pi-command",
      "true"
    ]);
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    await expect(
      access(path.join(stateDir, "pi-config-runtime", "models.json"))
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(stateDir, "pi-extensions", "tool-approval.ts"))
    ).resolves.toBeUndefined();
  });

  it("uses remembered thinking unless a localpi thinking override is set", async () => {
    const stateDir = await tempStateDir();
    const baseUrl = await startModelServer("served-model", 4096);
    const scriptPath = path.join(stateDir, "fake-pi.cjs");
    const firstLogPath = path.join(stateDir, "remembered-launch.json");
    await writeFile(path.join(stateDir, "thinking.json"), JSON.stringify({ thinking: "high" }));
    await writeFile(scriptPath, fakePiLaunchScript(firstLogPath));

    const remembered = await run([
      "--runtime",
      "lmstudio",
      "--base-url",
      baseUrl,
      "--state-dir",
      stateDir,
      "--session-dir",
      path.join(stateDir, "sessions"),
      "--pi-command",
      `node ${scriptPath}`
    ]);

    expect(remembered).toEqual({ code: 0, stdout: "", stderr: "" });
    const rememberedRecord = JSON.parse(await readFile(firstLogPath, "utf8")) as {
      readonly args: readonly string[];
    };
    expect(argValue(rememberedRecord.args, "--thinking")).toBe("high");
    const rememberedSettings = JSON.parse(
      await readFile(path.join(stateDir, "pi-config-runtime", "settings.json"), "utf8")
    ) as { readonly defaultThinkingLevel?: string };
    expect(rememberedSettings.defaultThinkingLevel).toBe("high");

    const secondLogPath = path.join(stateDir, "override-launch.json");
    await writeFile(scriptPath, fakePiLaunchScript(secondLogPath));
    const overridden = await run([
      "--runtime",
      "lmstudio",
      "--base-url",
      baseUrl,
      "--state-dir",
      stateDir,
      "--session-dir",
      path.join(stateDir, "sessions"),
      "--pi-command",
      `node ${scriptPath}`,
      "--thinking",
      "low"
    ]);

    expect(overridden).toEqual({ code: 0, stdout: "", stderr: "" });
    const overriddenRecord = JSON.parse(await readFile(secondLogPath, "utf8")) as {
      readonly args: readonly string[];
    };
    expect(argValue(overriddenRecord.args, "--thinking")).toBe("low");
  });

  it("keeps provider-only interactive launches eligible for Pi-native startup selection", async () => {
    const stateDir = await tempStateDir();
    const baseUrl = await startModelListServer(["first", "second"]);
    setTty("stdin", true);
    setTty("stdout", true);

    const result = await run([
      "--runtime",
      "lmstudio",
      "--provider",
      "lmstudio",
      "--base-url",
      baseUrl,
      "--state-dir",
      stateDir,
      "--session-dir",
      path.join(stateDir, "sessions"),
      "--pi-command",
      "true"
    ]);

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    await expect(
      access(path.join(stateDir, "pi-extensions", "startup-model-selector.ts"))
    ).resolves.toBeUndefined();
  });

  it("propagates non-zero pi exit codes", async () => {
    const stateDir = await tempStateDir();
    const baseUrl = await startModelServer("served-model", 4096);
    const result = await run([
      "--runtime",
      "lmstudio",
      "--base-url",
      baseUrl,
      "--state-dir",
      stateDir,
      "--session-dir",
      path.join(stateDir, "sessions"),
      "--pi-command",
      "sh -c 'exit 7' --"
    ]);
    expect(result).toEqual({ code: 7, stdout: "", stderr: "" });
  });

  it("launches demo mode once with a generated TUI extension", async () => {
    const stateDir = await tempStateDir();
    const baseUrl = await startModelServer("served-model", 4096);
    const scriptPath = path.join(stateDir, "fake-pi.cjs");
    const logPath = path.join(stateDir, "demo-launch.json");
    await writeFile(scriptPath, fakePiLaunchScript(logPath));
    setTty("stdin", true);
    setTty("stdout", true);

    const result = await run([
      "--demo",
      "--demo-initial-prompt",
      "- start story",
      "--demo-followup-prompt",
      "@keep going",
      "--runtime",
      "lmstudio",
      "--base-url",
      baseUrl,
      "--model",
      "served-model",
      "--state-dir",
      stateDir,
      "--session-dir",
      path.join(stateDir, "sessions"),
      "--pi-command",
      `node ${scriptPath}`,
      "--no-tools"
    ]);

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    const record = JSON.parse(await readFile(logPath, "utf8")) as {
      readonly args: readonly string[];
    };
    expect(record.args).toContain("--no-tools");
    expect(record.args).not.toContain("-p");
    expect(record.args).not.toContain("--prompt");
    expect(record.args).not.toContain("--session-id");
    const extensionArgs = extensionPaths(record.args);
    const demoPath = extensionArgs.find(
      (extensionPath) => path.basename(extensionPath) === "demo-mode.ts"
    );
    expect(demoPath).toBe(path.join(stateDir, "pi-extensions", "demo-mode.ts"));
    const demo = await readFile(demoPath ?? "", "utf8");
    expect(demo).toContain('const initialPrompt = "- start story";');
    expect(demo).toContain('const followupPrompt = "@keep going";');
    expect(demo).toContain('pi.on("session_start"');
    expect(demo).toContain('pi.on("turn_end"');
    expect(demo).toContain("pi.sendUserMessage(initialPrompt)");
  });

  it("requires a TTY in demo mode", async () => {
    setTty("stdin", false);
    setTty("stdout", true);
    const noStdin = await run(["--demo", "--model", "served-model"]);
    expect(noStdin.code).toBe(2);
    expect(noStdin.stdout).toBe("");
    expect(noStdin.stderr).toContain("--demo requires an interactive TTY on stdin and stdout");

    setTty("stdin", true);
    setTty("stdout", false);
    const noStdout = await run(["--demo", "--model", "served-model"]);
    expect(noStdout.code).toBe(2);
    expect(noStdout.stdout).toBe("");
    expect(noStdout.stderr).toContain("--demo requires an interactive TTY on stdin and stdout");
  });

  async function startModelServer(model: string, contextWindow: number): Promise<string> {
    const server = createServer((request, response) => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: model, context_length: contextWindow }] }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    servers.push(server);
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${String(address.port)}/v1`;
  }

  async function startModelListServer(models: readonly string[]): Promise<string> {
    const server = createServer((request, response) => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: models.map((id) => ({ id, context_length: 4096 })) }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    servers.push(server);
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${String(address.port)}/v1`;
  }

  async function unusedBaseUrl(): Promise<string> {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${String(address.port)}/v1`;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    return baseUrl;
  }

  async function tempStateDir(): Promise<string> {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-cli-"));
    tempDirs.push(stateDir);
    return stateDir;
  }

  function setTty(stream: "stdin" | "stdout", value: boolean | undefined): void {
    Object.defineProperty(process[stream], "isTTY", {
      configurable: true,
      value
    });
  }

  function extensionPaths(args: readonly string[]): readonly string[] {
    const paths: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const extensionPath = args[index + 1];
      if (args[index] === "--extension" && extensionPath !== undefined) {
        paths.push(extensionPath);
      }
    }
    return paths;
  }

  function argValue(args: readonly string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  }

  function fakePiLaunchScript(logPath: string): string {
    return [
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      `const logPath = ${JSON.stringify(logPath)};`,
      "fs.writeFileSync(logPath, JSON.stringify({ args }));"
    ].join("\n");
  }
});
