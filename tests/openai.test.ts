import { describe, expect, it } from "vitest";

import {
  fetchServerProps,
  listModels,
  normalizeBaseUrl,
  resolveLocalModel
} from "../src/llm/openai.js";
// Type-only module; loaded so coverage sees the file as exercised.
import "../src/llm/types.js";

describe("OpenAI-compatible model discovery", () => {
  it("lists model ids", async () => {
    const models = await listModels("http://local.test/v1", 1000, () =>
      Promise.resolve(jsonResponse({ data: [{ id: "gemma-4-e4b-it" }] }))
    );
    expect(models).toEqual([{ id: "gemma-4-e4b-it" }]);
  });

  it("resolves auto to the first model id", async () => {
    const resolved = await resolveLocalModel("http://local.test/v1", "auto", 1000, () =>
      Promise.resolve(jsonResponse({ data: [{ id: "gemma-4-e4b-it" }] }))
    );
    expect(resolved.model).toBe("gemma-4-e4b-it");
  });

  it("keeps optional context metadata when the server reports it", async () => {
    const resolved = await resolveLocalModel("http://local.test/v1", "auto", 1000, () =>
      Promise.resolve(jsonResponse({ data: [{ id: "gemma-4-e4b-it", context_length: 120000 }] }))
    );
    expect(resolved.contextWindow).toBe(120000);
  });

  it("reads llama.cpp model status and nested meta context", async () => {
    const models = await listModels("http://local.test/v1", 1000, () =>
      Promise.resolve(
        jsonResponse({
          data: [
            { id: "qwen3-27b", status: { value: "unloaded" } },
            { id: "bonsai-27b", status: { value: "loaded" }, meta: { n_ctx: 32768 } }
          ]
        })
      )
    );
    expect(models).toEqual([
      { id: "qwen3-27b", status: "unloaded" },
      { id: "bonsai-27b", status: "loaded", contextWindow: 32768 }
    ]);
  });

  it("ignores unknown llama.cpp status values", async () => {
    const models = await listModels("http://local.test/v1", 1000, () =>
      Promise.resolve(jsonResponse({ data: [{ id: "kept", status: { value: "loading" } }] }))
    );
    expect(models).toEqual([{ id: "kept" }]);
  });

  it("reads llama.cpp server props from the server root", async () => {
    const requested: string[] = [];
    const props = await fetchServerProps("http://local.test/v1", 1000, (input) => {
      requested.push(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      );
      return Promise.resolve(jsonResponse({ role: "router", models_autoload: true }));
    });
    expect(requested).toEqual(["http://local.test/props"]);
    expect(props).toEqual({ role: "router", modelsAutoload: true });
  });

  it("rejects HTTP errors from the server props endpoint", async () => {
    await expect(
      fetchServerProps("http://local.test/v1", 1000, () =>
        Promise.resolve(new Response("nope", { status: 404 }))
      )
    ).rejects.toThrow("server props failed with HTTP 404");
  });

  it("strips trailing slashes from base URLs", () => {
    expect(normalizeBaseUrl("http://local.test/v1///")).toBe("http://local.test/v1");
  });

  it("rejects HTTP errors from the model endpoint", async () => {
    await expect(
      listModels("http://local.test/v1", 1000, () =>
        Promise.resolve(new Response("nope", { status: 500 }))
      )
    ).rejects.toThrow("model list failed with HTTP 500");
  });

  it("ignores model entries without string ids", async () => {
    const models = await listModels("http://local.test/v1", 1000, () =>
      Promise.resolve(jsonResponse({ data: [{ object: "model" }, { id: "kept" }] }))
    );
    expect(models).toEqual([{ id: "kept" }]);
  });

  it("rejects auto resolution when no models are available", async () => {
    await expect(
      resolveLocalModel("http://local.test/v1", "auto", 1000, () =>
        Promise.resolve(jsonResponse({ data: [] }))
      )
    ).rejects.toThrow("no models returned by http://local.test/v1/models");
  });

  it("rejects requested models the server does not report", async () => {
    await expect(
      resolveLocalModel("http://local.test/v1", "missing", 1000, () =>
        Promise.resolve(jsonResponse({ data: [{ id: "served" }] }))
      )
    ).rejects.toThrow("model missing is not reported by http://local.test/v1/models");
  });

  it("finds context windows in nested metadata and numeric strings", async () => {
    const resolved = await resolveLocalModel("http://local.test/v1", "served", 1000, () =>
      Promise.resolve(jsonResponse({ data: [{ id: "served", metadata: { n_ctx: "4096" } }] }))
    );
    expect(resolved).toMatchObject({ model: "served", contextWindow: 4096 });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
