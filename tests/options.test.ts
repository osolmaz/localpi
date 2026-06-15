import { afterEach, describe, expect, it } from "vitest";

import { parseLocalpiArgs, usage } from "../src/localpi/options.js";

describe("localpi option parsing", () => {
  it("keeps pi args as pass-through arguments", () => {
    const options = parseLocalpiArgs(["--model", "gemma-e4b", "-p", "write a plan"]);
    expect(options.model).toBe("gemma-e4b");
    expect(options.forwardedArgs).toEqual(["-p", "write a plan"]);
  });

  it("uses -- to forward pi flags that localpi also owns", () => {
    const options = parseLocalpiArgs(["--model", "gemma-e4b", "--", "--model", "pi-level"]);
    expect(options.model).toBe("gemma-e4b");
    expect(options.forwardedArgs).toEqual(["--model", "pi-level"]);
  });

  it("parses runtime and llama-server options", () => {
    const options = parseLocalpiArgs([
      "--runtime",
      "lmstudio",
      "--base-url",
      "http://127.0.0.1:1234/v1/",
      "--ctx",
      "32768",
      "--port",
      "18195",
      "--no-approval",
      "--no-token-status"
    ]);
    expect(options.runtime).toBe("lmstudio");
    expect(options.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(options.contextWindow).toBe(32768);
    expect(options.port).toBe(18195);
    expect(options.approval).toBe(false);
    expect(options.tokenStatus).toBe(false);
    expect(parseLocalpiArgs(["--runtime", "vllm"]).runtime).toBe("vllm");
  });

  it("parses and validates thinking levels", () => {
    expect(parseLocalpiArgs(["--thinking", "low"]).thinking).toBe("low");
    expect(parseLocalpiArgs(["--thinking", "xhigh"]).thinking).toBe("xhigh");
    expect(() => parseLocalpiArgs(["--thinking", "banana"])).toThrow(
      "unknown thinking level banana"
    );
  });

  it("rejects removed final schema flags", () => {
    expect(() => parseLocalpiArgs(["--final-schema", "schema.json"])).toThrow(
      "was removed from localpi"
    );
    expect(() => parseLocalpiArgs(["--schema", "schema.json"])).toThrow("was removed from localpi");
  });

  it("turns -h and --help into a single forwarded help flag", () => {
    expect(parseLocalpiArgs(["-h"]).forwardedArgs).toEqual(["--help"]);
    expect(parseLocalpiArgs(["--help", "-p", "ignored"]).forwardedArgs).toEqual(["--help"]);
  });

  it("parses boolean command flags", () => {
    expect(parseLocalpiArgs(["--status"]).status).toBe(true);
    expect(parseLocalpiArgs(["--stop"]).stop).toBe(true);
    expect(parseLocalpiArgs(["--list"]).list).toBe(true);
  });

  it("parses every value flag", () => {
    const options = parseLocalpiArgs([
      "--model",
      "custom",
      "--provider",
      "vllm",
      "--provider-id",
      "my-provider",
      "--providers-file",
      "/tmp/localpi-providers.json",
      "--state-dir",
      "/tmp/localpi-state",
      "--session-dir",
      "/tmp/localpi-sessions",
      "--pi-command",
      "my-pi",
      "--context-window",
      "4096",
      "--max-tokens",
      "2048",
      "--timeout-ms",
      "1500",
      "--server-command",
      "/opt/bin/llama-server",
      "--host",
      "0.0.0.0",
      "--gpu-layers",
      "0",
      "--parallel",
      "2",
      "--chat-template",
      "/tmp/template.jinja",
      "--tools",
      "read,bash"
    ]);
    expect(options).toMatchObject({
      model: "custom",
      provider: "vllm",
      providerId: "my-provider",
      providersFile: "/tmp/localpi-providers.json",
      stateDir: "/tmp/localpi-state",
      sessionDir: "/tmp/localpi-sessions",
      piCommand: "my-pi",
      contextWindow: 4096,
      maxTokens: 2048,
      timeoutMs: 1500,
      serverCommand: "/opt/bin/llama-server",
      host: "0.0.0.0",
      gpuLayers: 0,
      parallel: 2,
      chatTemplate: "/tmp/template.jinja",
      tools: "read,bash"
    });
    expect(parseLocalpiArgs(["--llama-server", "/opt/bin/other"]).serverCommand).toBe(
      "/opt/bin/other"
    );
  });

  it("rejects malformed flag values", () => {
    expect(() => parseLocalpiArgs(["--model"])).toThrow("--model requires a value");
    expect(() => parseLocalpiArgs(["--port", "0"])).toThrow("expected a positive integer, got 0");
    expect(() => parseLocalpiArgs(["--gpu-layers", "-1"])).toThrow(
      "expected a non-negative integer, got -1"
    );
    expect(() => parseLocalpiArgs(["--runtime", "banana"])).toThrow("unknown runtime banana");
  });

  it("documents the supported flags in usage output", () => {
    const text = usage();
    expect(text).toContain("localpi [localpi options] [pi options/messages]");
    expect(text).toContain("--runtime <kind>");
    expect(text).toContain("--thinking <level>");
  });
});

describe("localpi environment defaults", () => {
  const names = [
    "LOCALPI_BASE_URL",
    "LOCALPI_CONTEXT_WINDOW",
    "LOCALPI_APPROVAL",
    "LOCALPI_TOKEN_STATUS",
    "LOCALPI_MODEL",
    "LOCALPI_PROVIDER",
    "LOCALPI_PROVIDERS_FILE",
    "LOCALPI_SESSION_DIR"
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));

  afterEach(() => {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
  });

  it("reads defaults from LOCALPI_* environment variables", () => {
    process.env["LOCALPI_BASE_URL"] = "http://127.0.0.1:9999/v1/";
    process.env["LOCALPI_CONTEXT_WINDOW"] = "16384";
    process.env["LOCALPI_APPROVAL"] = "no";
    process.env["LOCALPI_TOKEN_STATUS"] = "1";
    process.env["LOCALPI_MODEL"] = "env-model";
    process.env["LOCALPI_PROVIDER"] = "env-provider";
    process.env["LOCALPI_PROVIDERS_FILE"] = "/tmp/env-providers.json";
    process.env["LOCALPI_SESSION_DIR"] = "/tmp/localpi-env-sessions";

    expect(parseLocalpiArgs([])).toMatchObject({
      baseUrl: "http://127.0.0.1:9999/v1",
      contextWindow: 16384,
      approval: false,
      tokenStatus: true,
      model: "env-model",
      provider: "env-provider",
      providersFile: "/tmp/env-providers.json",
      sessionDir: "/tmp/localpi-env-sessions"
    });
  });

  it("rejects non boolean-like environment toggles", () => {
    process.env["LOCALPI_APPROVAL"] = "maybe";
    expect(() => parseLocalpiArgs([])).toThrow("LOCALPI_APPROVAL must be boolean-like, got maybe");
  });
});
