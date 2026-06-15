import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultLlamaModelName,
  findModelAlias,
  listModelAliases,
  resolveLlamaModel
} from "../src/localpi/models.js";

describe("model aliases", () => {
  const previousModelsFile = process.env["LOCALPI_MODELS_FILE"];

  afterEach(() => {
    if (previousModelsFile === undefined) {
      delete process.env["LOCALPI_MODELS_FILE"];
    } else {
      process.env["LOCALPI_MODELS_FILE"] = previousModelsFile;
    }
  });

  it("lists built-in Gemma aliases", async () => {
    const aliases = await listModelAliases("/home/example");
    expect(aliases.map((alias) => alias.name)).toContain("gemma-12b");
    expect(await findModelAlias("gemma-e4b", "/home/example")).toMatchObject({
      id: "gemma-4-e4b-it"
    });
  });

  it("resolves configured aliases from LOCALPI_MODELS_FILE", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "localpi-models-"));
    try {
      const modelPath = path.join(dir, "custom.gguf");
      const configPath = path.join(dir, "models.json");
      await writeFile(modelPath, "", "utf8");
      await writeFile(
        configPath,
        JSON.stringify({
          models: {
            custom: {
              id: "custom-id",
              path: modelPath,
              contextWindow: 8192
            }
          }
        }),
        "utf8"
      );
      process.env["LOCALPI_MODELS_FILE"] = configPath;

      const resolved = await resolveLlamaModel("custom", undefined, dir);
      expect(resolved).toMatchObject({
        source: "alias",
        name: "custom",
        id: "custom-id",
        modelPath,
        contextWindow: 8192
      });
      await expect(resolveLlamaModel("custom-id", undefined, dir)).resolves.toMatchObject({
        source: "alias",
        name: "custom",
        id: "custom-id",
        modelPath,
        contextWindow: 8192
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("allows provider-only LOCALPI_MODELS_FILE configs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "localpi-models-"));
    try {
      const configPath = path.join(dir, "models.json");
      await writeFile(
        configPath,
        JSON.stringify({
          providers: {
            vllm: {
              type: "openai-compatible",
              baseUrl: "http://127.0.0.1:8000/v1"
            }
          }
        }),
        "utf8"
      );
      process.env["LOCALPI_MODELS_FILE"] = configPath;

      await expect(listModelAliases(dir)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "gemma-12b" })])
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a GGUF path as a custom model", async () => {
    const resolved = await resolveLlamaModel("/models/My Model.gguf");
    expect(resolved).toMatchObject({
      source: "path",
      id: "my-model",
      modelPath: "/models/My Model.gguf"
    });
  });

  it("defaults the llama model to the built-in gemma alias", () => {
    expect(defaultLlamaModelName()).toBe("gemma-12b");
  });

  it("rejects unknown aliases with a hint", async () => {
    await expect(resolveLlamaModel("nope", undefined, "/home/example")).rejects.toThrow(
      "unknown llama-server model alias nope; pass a GGUF path or use --list"
    );
  });

  it("rejects aliases whose GGUF files are not installed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "localpi-models-"));
    try {
      const configPath = path.join(dir, "models.json");
      await writeFile(
        configPath,
        JSON.stringify({ models: { ghost: { path: path.join(dir, "missing.gguf") } } }),
        "utf8"
      );
      process.env["LOCALPI_MODELS_FILE"] = configPath;
      await expect(resolveLlamaModel("ghost", undefined, dir)).rejects.toThrow(
        "model alias ghost has no installed GGUF"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects configured aliases without any path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "localpi-models-"));
    try {
      const configPath = path.join(dir, "models.json");
      await writeFile(configPath, JSON.stringify({ models: { broken: { id: "x" } } }), "utf8");
      process.env["LOCALPI_MODELS_FILE"] = configPath;
      await expect(listModelAliases(dir)).rejects.toThrow(
        "model alias broken must define path or paths"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
