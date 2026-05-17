import { describe, expect, it } from "vitest";

import { scoreDocument, type Taxonomy } from "../src/gitcrawl/taxonomy.js";

const taxonomy: Taxonomy = {
  keywordGroups: [{ id: "runtime", weight: 9, terms: ["lm studio", "ollama"] }],
  regexGroups: [{ id: "provider", weight: 7, terms: ["\\blmstudio/[A-Za-z0-9._:-]+"] }]
};

describe("taxonomy scoring", () => {
  it("scores keyword and regex groups once each", () => {
    const scored = scoreDocument("LM Studio endpoint uses lmstudio/gemma-local", taxonomy);
    expect(scored.score).toBe(16);
    expect(scored.matches.map((match) => match.group)).toEqual(["runtime", "provider"]);
  });
});
