import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type FinalSchemaRuntime = {
  readonly extensionPath: string;
  readonly outputPath: string;
  readonly instruction: string;
};

export async function createFinalSchemaRuntime(
  schemaPath: string,
  stateDir: string
): Promise<FinalSchemaRuntime> {
  const resolvedSchemaPath = path.resolve(schemaPath);
  const schema = parseSchema(await readFile(resolvedSchemaPath, "utf8"), resolvedSchemaPath);
  const runtimeDir = await createRuntimeDir(stateDir);
  const outputPath = path.join(runtimeDir, "final-output.json");
  const extensionPath = path.join(runtimeDir, "final-json-extension.ts");
  await writeFile(extensionPath, extensionSource(schema, outputPath), "utf8");
  return {
    extensionPath,
    outputPath,
    instruction: [
      "This localagent run requires structured final output.",
      "When the task is complete, call the final_json tool exactly once with the final answer.",
      "The final_json tool parameters are the required JSON schema.",
      "Do not answer with final prose instead of calling final_json."
    ].join("\n")
  };
}

export async function readFinalSchemaOutput(outputPath: string): Promise<string> {
  try {
    await access(outputPath, constants.R_OK);
  } catch {
    throw new Error("final_json was not called; no structured output was captured");
  }
  const raw = await readFile(outputPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return JSON.stringify(parsed, null, 2) + "\n";
}

function parseSchema(raw: string, schemaPath: string): unknown {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`final schema must be a JSON object: ${schemaPath}`);
  }
  if (parsed["type"] !== "object") {
    throw new Error("final schema root type must be object");
  }
  return parsed;
}

async function createRuntimeDir(stateDir: string): Promise<string> {
  const root = path.join(stateDir, "structured-output");
  await mkdir(root, { recursive: true });
  return await mkdtemp(path.join(root, "run-"));
}

function extensionSource(schema: unknown, outputPath: string): string {
  return [
    'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
    'import { writeFileSync } from "node:fs";',
    "",
    `const schema = ${JSON.stringify(schema, null, 2)} as const;`,
    `const outputPath = ${JSON.stringify(outputPath)};`,
    "",
    "export default function localagentFinalJsonExtension(pi: ExtensionAPI): void {",
    "  pi.registerTool({",
    '    name: "final_json",',
    '    label: "Final JSON",',
    '    description: "Submit the final structured answer and end the run.",',
    '    promptSnippet: "Use final_json to submit the final structured answer. Call it exactly once after completing the requested work.",',
    "    promptGuidelines: [",
    '      "Complete any required investigation first.",',
    '      "When done, call final_json with the final answer.",',
    '      "Do not write the final answer as ordinary prose."',
    "    ],",
    "    parameters: schema,",
    "    async execute(_toolCallId: string, params: unknown) {",
    '      writeFileSync(outputPath, JSON.stringify(params, null, 2) + "\\n", "utf8");',
    "      return {",
    '        content: [{ type: "text", text: "Structured final answer captured." }],',
    "        details: { outputPath },",
    "        terminate: true",
    "      };",
    "    }",
    "  });",
    "}",
    ""
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
