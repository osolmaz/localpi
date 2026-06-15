import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { LocalpiOptions } from "../src/localpi/options.js";
import { writeDefaultExtensions } from "../src/pi/extensions.js";

describe("Pi extensions", () => {
  it("writes approval and token status extensions", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-ext-"));
    try {
      const bundle = await writeDefaultExtensions(options(stateDir));
      expect(bundle.paths).toHaveLength(2);
      expect(bundle.systemPrompt).toContain("Tool calls require user approval");
      const approval = await readFile(bundle.paths[0] ?? "", "utf8");
      const status = await readFile(bundle.paths[1] ?? "", "utf8");
      expect(approval).toContain("ctx.ui.confirm");
      expect(status).toContain("tok/s");
      expect(status).toContain("message_update");
      expect(status).toContain("currentTurn");
      expect(status).toContain("outputText += update.text");
      expect(status).toContain('kind: "delta"');
      expect(status).not.toContain("turns.get(event.turnIndex)");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("skips extensions and reports disabled approval when both are off", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localpi-ext-"));
    try {
      const bundle = await writeDefaultExtensions({
        ...options(stateDir),
        approval: false,
        tokenStatus: false
      });
      expect(bundle.paths).toHaveLength(0);
      expect(bundle.systemPrompt).toContain("Tool approval is disabled for this session.");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

function options(stateDir: string): LocalpiOptions {
  return {
    runtime: "llama-server",
    baseUrl: undefined,
    model: "gemma-12b",
    provider: undefined,
    providerId: "local-openai",
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
    status: false,
    stop: false,
    list: false,
    forwardedArgs: []
  };
}
