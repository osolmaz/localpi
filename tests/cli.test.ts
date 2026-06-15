import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { run } from "../src/cli/cli.js";

describe("localpi cli", () => {
  const servers: ReturnType<typeof createServer>[] = [];
  const tempDirs: string[] = [];
  const previousModelsFile = process.env["LOCALPI_MODELS_FILE"];

  afterEach(async () => {
    if (previousModelsFile === undefined) {
      delete process.env["LOCALPI_MODELS_FILE"];
    } else {
      process.env["LOCALPI_MODELS_FILE"] = previousModelsFile;
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
});
