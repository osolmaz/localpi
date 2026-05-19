import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { LocalagentOptions } from "../src/localagent/options.js";
import { writeRuntimeConfig } from "../src/pi/config.js";

describe("Pi runtime config", () => {
  it("writes a local OpenAI-compatible provider config", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localagent-test-"));
    try {
      const runtime = await writeRuntimeConfig(options(stateDir), "gemma-local");
      const models = JSON.parse(await readFile(runtime.modelsPath, "utf8")) as {
        providers: Record<string, { baseUrl: string; models: readonly { id: string }[] }>;
      };
      expect(models.providers["local-openai"]?.baseUrl).toBe("http://127.0.0.1:1234/v1");
      expect(models.providers["local-openai"]?.models[0]?.id).toBe("gemma-local");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

function options(stateDir: string): LocalagentOptions {
  return {
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "auto",
    providerId: "local-openai",
    stateDir,
    sessionDir: path.join(stateDir, "sessions"),
    piCommand: "pi",
    thinking: "off",
    contextWindow: 65536,
    maxTokens: 8192,
    timeoutMs: 1000,
    finalSchemaPath: undefined,
    status: false,
    forwardedArgs: []
  };
}
