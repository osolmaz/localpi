import { describe, expect, it } from "vitest";

import { listModels, resolveLocalModel } from "../src/llm/openai.js";

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
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
