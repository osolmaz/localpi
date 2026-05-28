import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { LocalagentOptions } from "../src/localagent/options.js";
import type { RuntimeConfig } from "../src/pi/config.js";
import { createLaunchPlan } from "../src/pi/launch.js";
import { createFinalSchemaRuntime, readFinalSchemaOutput } from "../src/structured/final-schema.js";

describe("structured output", () => {
  it("ships a context-agnostic example schema", async () => {
    const raw = await readFile(
      path.join(process.cwd(), "examples", "schemas", "binary-classifier.schema.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as {
      type?: string;
      required?: string[];
      properties?: { label?: { enum?: string[] } };
    };

    expect(parsed.type).toBe("object");
    expect(parsed.required).toEqual([
      "is_match",
      "label",
      "confidence",
      "summary",
      "reasons",
      "caveats"
    ]);
    expect(parsed.properties?.label?.enum).toEqual([
      "match",
      "partial_match",
      "no_match",
      "unclear"
    ]);
  });

  it("creates a final_json extension from a schema", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localagent-structured-"));
    try {
      const schemaPath = path.join(stateDir, "schema.json");
      await writeFile(schemaPath, JSON.stringify(schema()), "utf8");
      const runtime = await createFinalSchemaRuntime(schemaPath, stateDir);
      const source = await readFile(runtime.extensionPath, "utf8");

      expect(runtime.outputPath).toMatch(/final-output\.json$/u);
      expect(runtime.instruction).toContain("call the final_json tool exactly once");
      expect(source).toContain('name: "final_json"');
      expect(source).toContain('"is_local_model_related"');
      expect(source).toContain('"interest"');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("prints captured structured output as pretty JSON", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "localagent-structured-"));
    try {
      const outputPath = path.join(stateDir, "final-output.json");
      await writeFile(outputPath, '{"interest":"i0"}\n', "utf8");
      await expect(readFinalSchemaOutput(outputPath)).resolves.toBe('{\n  "interest": "i0"\n}\n');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("adds the generated extension and final_json allowlist to Pi args", async () => {
    const runtime = {
      extensionPath: "/tmp/final-json-extension.ts",
      outputPath: "/tmp/final-output.json",
      instruction: "call final_json"
    };
    const plan = await createLaunchPlan(
      {
        ...options("/tmp/localagent-state"),
        forwardedArgs: ["--tools", "bash", "-p", "classify"]
      },
      runtimeConfig("/tmp/localagent-state"),
      "gemma-4-e4b-it",
      runtime
    );

    expect(plan.finalSchemaOutputPath).toBe("/tmp/final-output.json");
    expect(plan.args).toEqual([
      "--provider",
      "local-openai",
      "--model",
      "gemma-4-e4b-it",
      "--thinking",
      "off",
      "--extension",
      "/tmp/final-json-extension.ts",
      "--append-system-prompt",
      "call final_json",
      "--tools",
      "bash,final_json",
      "-p",
      "classify"
    ]);
  });

  it("rejects schema mode when Pi tools are disabled", async () => {
    await expect(
      createLaunchPlan(
        { ...options("/tmp/localagent-state"), forwardedArgs: ["--no-tools"] },
        runtimeConfig("/tmp/localagent-state"),
        "gemma-4-e4b-it",
        {
          extensionPath: "/tmp/final-json-extension.ts",
          outputPath: "/tmp/final-output.json",
          instruction: "call final_json"
        }
      )
    ).rejects.toThrow("--final-schema cannot be used with --no-tools");

    await expect(
      createLaunchPlan(
        { ...options("/tmp/localagent-state"), forwardedArgs: ["-nt"] },
        runtimeConfig("/tmp/localagent-state"),
        "gemma-4-e4b-it",
        {
          extensionPath: "/tmp/final-json-extension.ts",
          outputPath: "/tmp/final-output.json",
          instruction: "call final_json"
        }
      )
    ).rejects.toThrow("--final-schema cannot be used with --no-tools");
  });

  it("rejects schema mode outside Pi print mode", async () => {
    await expect(
      createLaunchPlan(
        { ...options("/tmp/localagent-state"), forwardedArgs: ["classify"] },
        runtimeConfig("/tmp/localagent-state"),
        "gemma-4-e4b-it",
        {
          extensionPath: "/tmp/final-json-extension.ts",
          outputPath: "/tmp/final-output.json",
          instruction: "call final_json"
        }
      )
    ).rejects.toThrow("--final-schema requires Pi print mode");
  });
});

function schema(): unknown {
  return {
    type: "object",
    additionalProperties: false,
    required: ["is_local_model_related", "interest"],
    properties: {
      is_local_model_related: { type: "boolean" },
      interest: { type: "string", enum: ["i0", "i1", "i2", "i3", "i4"] }
    }
  };
}

function options(stateDir: string): LocalagentOptions {
  return {
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "auto",
    providerId: "local-openai",
    stateDir,
    sessionDir: path.join(stateDir, "sessions"),
    piCommand: "pi",
    thinking: "off",
    contextWindow: undefined,
    maxTokens: 8192,
    timeoutMs: 1000,
    finalSchemaPath: undefined,
    status: false,
    forwardedArgs: []
  };
}

function runtimeConfig(stateDir: string): RuntimeConfig {
  return {
    configDir: path.join(stateDir, "pi"),
    modelsPath: path.join(stateDir, "pi", "models.json"),
    settingsPath: path.join(stateDir, "pi", "settings.json")
  };
}
