import { describe, expect, it } from "vitest";

import { parseLocalpiArgs } from "../src/localpi/options.js";

describe("localpi option parsing", () => {
  it("keeps pi args as pass-through arguments", () => {
    const options = parseLocalpiArgs(["--model", "gemma-e4b", "-p", "write a plan"]);
    expect(options.model).toBe("gemma-e4b");
    expect(options.forwardedArgs).toEqual(["-p", "write a plan"]);
  });

  it("uses -- to forward pi flags that localpi also owns", () => {
    const options = parseLocalpiArgs(["--model", "gemma-e4b", "--", "--model", "pi-level"]);
    expect(options.model).toBe("gemma-e4b");
    expect(options.forwardedArgs).toEqual(["--model", "pi-level"]);
  });

  it("parses runtime and llama-server options", () => {
    const options = parseLocalpiArgs([
      "--runtime",
      "lmstudio",
      "--base-url",
      "http://127.0.0.1:1234/v1/",
      "--ctx",
      "32768",
      "--port",
      "18195",
      "--no-approval",
      "--no-token-status"
    ]);
    expect(options.runtime).toBe("lmstudio");
    expect(options.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(options.contextWindow).toBe(32768);
    expect(options.port).toBe(18195);
    expect(options.approval).toBe(false);
    expect(options.tokenStatus).toBe(false);
  });

  it("rejects removed final schema flags", () => {
    expect(() => parseLocalpiArgs(["--final-schema", "schema.json"])).toThrow(
      "was removed from localpi"
    );
    expect(() => parseLocalpiArgs(["--schema", "schema.json"])).toThrow("was removed from localpi");
  });
});
