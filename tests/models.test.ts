import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findModelAlias, listModelAliases, resolveLlamaModel } from "../src/localpi/models.js";

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
});
