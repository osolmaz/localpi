import { describe, expect, it } from "vitest";

import { complete, listModels, resolveModel } from "../src/llm/openai.js";

describe("openai-compatible client", () => {
  it("lists model ids", async () => {
    const models = await listModels("http://local.test/v1", 1000, () =>
      Promise.resolve(jsonResponse({ data: [{ id: "gemma-local" }] }))
    );
    expect(models).toEqual(["gemma-local"]);
  });

  it("resolves auto model to the first listed id", async () => {
    const model = await resolveModel("http://local.test/v1", "auto", 1000, () =>
      Promise.resolve(jsonResponse({ data: [{ id: "gemma-local" }] }))
    );
    expect(model).toBe("gemma-local");
  });

  it("reads chat completion content", async () => {
    const result = await complete(
      {
        baseUrl: "http://local.test/v1",
        model: "gemma-local",
        messages: [{ role: "user", content: "write" }],
        maxTokens: 32,
        temperature: 0.2,
        timeoutMs: 1000
      },
      () =>
        Promise.resolve(
          jsonResponse({ model: "gemma-local", choices: [{ message: { content: "long text" } }] })
        )
    );
    expect(result).toEqual({ model: "gemma-local", content: "long text" });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
