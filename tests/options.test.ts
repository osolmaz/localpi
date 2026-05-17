import { describe, expect, it } from "vitest";

import { parseLocalagentArgs } from "../src/localagent/options.js";

describe("localagent option parsing", () => {
  it("keeps pi args as pass-through arguments", () => {
    const options = parseLocalagentArgs(["--model", "gemma-local", "-p", "write a plan"]);
    expect(options.model).toBe("gemma-local");
    expect(options.forwardedArgs).toEqual(["-p", "write a plan"]);
  });

  it("uses -- to forward pi flags that localagent also owns", () => {
    const options = parseLocalagentArgs([
      "--model",
      "gemma-local",
      "--",
      "--model",
      "ignored-by-wrapper"
    ]);
    expect(options.model).toBe("gemma-local");
    expect(options.forwardedArgs).toEqual(["--model", "ignored-by-wrapper"]);
  });
});
