import { describe, expect, it } from "vitest";

import { parseLocalagentArgs } from "../src/localagent/options.js";

describe("localagent option parsing", () => {
  it("keeps pi args as pass-through arguments", () => {
    const options = parseLocalagentArgs(["--model", "gemma-4-e4b-it", "-p", "write a plan"]);
    expect(options.model).toBe("gemma-4-e4b-it");
    expect(options.forwardedArgs).toEqual(["-p", "write a plan"]);
  });

  it("uses -- to forward pi flags that localagent also owns", () => {
    const options = parseLocalagentArgs([
      "--model",
      "gemma-4-e4b-it",
      "--",
      "--model",
      "ignored-by-wrapper"
    ]);
    expect(options.model).toBe("gemma-4-e4b-it");
    expect(options.forwardedArgs).toEqual(["--model", "ignored-by-wrapper"]);
  });

  it("parses final schema flags as localagent options", () => {
    expect(parseLocalagentArgs(["--final-schema", "schema.json"]).finalSchemaPath).toBe(
      "schema.json"
    );
    expect(parseLocalagentArgs(["--schema", "schema.json"]).finalSchemaPath).toBe("schema.json");
  });
});
