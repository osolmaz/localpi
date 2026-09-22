import { describe, expect, it } from "vitest";

import { engineEntries } from "../src/localpi/provider-registry.js";

describe("engine entries", () => {
  it("labels the built-in engines", () => {
    expect(
      engineEntries([
        { id: "llama-cpp", name: "llama.cpp", type: "llama-cpp", discover: true },
        { id: "lmstudio", name: "LM Studio", type: "openai-compatible", discover: true },
        { id: "vllm", name: "vLLM", type: "openai-compatible", discover: true },
        { id: "llama-server", name: "llama-server", type: "managed-llama-server", discover: true }
      ])
    ).toEqual([
      { provider: "llama-cpp", engine: "llama.cpp" },
      { provider: "lmstudio", engine: "LM Studio" },
      { provider: "vllm", engine: "vLLM" },
      { provider: "llama-server", engine: "llama-server" }
    ]);
  });

  it("labels a configured provider from its type", () => {
    expect(
      engineEntries([
        { id: "my-llama-box", name: "my-llama-box", type: "llama-cpp", discover: true }
      ])
    ).toEqual([{ provider: "my-llama-box", engine: "llama.cpp" }]);
  });

  it("leaves out a provider whose engine is unknown", () => {
    expect(
      engineEntries([
        { id: "my-endpoint", name: "my-endpoint", type: "openai-compatible", discover: true }
      ])
    ).toEqual([]);
  });

  it("keeps the first label for a repeated provider id", () => {
    expect(
      engineEntries([
        { id: "llama-cpp", name: "llama.cpp", type: "llama-cpp", discover: true },
        { id: "llama-cpp", name: "other", type: "llama-cpp", discover: true }
      ])
    ).toEqual([{ provider: "llama-cpp", engine: "llama.cpp" }]);
  });
});
