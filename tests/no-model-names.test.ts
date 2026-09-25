import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Capabilities come from flags, a model profile, or what the server reports, never from a model
// name. This guard keeps model family names out of the source so that no name check comes back.
const familyNames =
  /qwen|deepseek|gemma|gpt-?oss|bonsai|llama-?[0-9]|mistral|mixtral|phi-?[0-9]|glm|kimi|minimax|nemotron|granite|olmo|smollm/iu;

// The built-in model list is data that names models on purpose; it holds no capability logic.
const allowedFiles = new Set(["src/localpi/models.ts"]);

// Protocol values that carry a family name but select a wire format, not a model:
// Pi's thinking formats and llama-server's `--reasoning-format deepseek`.
const allowedLiterals = [
  /deepseek or qwen-chat-template/gu,
  /qwen-chat-template/gu,
  /"deepseek"/gu
];

describe("source code", () => {
  it("never names a model family outside the built-in model list", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles("src")) {
      if (allowedFiles.has(file)) {
        continue;
      }
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, index) => {
        const stripped = allowedLiterals.reduce((text, literal) => text.replace(literal, ""), line);
        if (familyNames.test(stripped)) {
          offenders.push(`${file}:${String(index + 1)}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

async function sourceFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? sourceFiles(full) : Promise.resolve([full]);
    })
  );
  return nested.flat();
}
