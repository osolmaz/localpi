import { describe, expect, it } from "vitest";

import { listModels, resolveLocalModel } from "../src/llm/openai.js";

describe("OpenAI-compatible model discovery", () => {
  it("lists model ids", async () => {
    const models = await listModels("http://local.test/v1", 1000, () =>
      Promise.resolve(jsonResponse({ data: [{ id: "gemma-local" }] }))
    );
    expect(models).toEqual(["gemma-local"]);
  });

  it("resolves auto to the first model id", async () => {
    const resolved = await resolveLocalModel("http://local.test/v1", "auto", 1000, () =>
      Promise.resolve(jsonResponse({ data: [{ id: "gemma-local" }] }))
    );
    expect(resolved.model).toBe("gemma-local");
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
