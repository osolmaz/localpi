import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

import { parseLocalpiArgs } from "../src/localpi/options.js";
import { writeDefaultExtensions } from "../src/pi/extensions.js";
import { cleanupTemporaryDirs, makeTemporaryDir } from "./support/extension-harness.js";

// Pi's own types are a devDependency, so these checks catch drift between the extension API that
// Pi ships today and the shapes localpi generates. The check directory must stay inside the
// repository, because the generated extensions import Pi's package by name.
const checkDirectory = path.join("node_modules", ".cache", "localpi-extension-types");

afterAll(async () => {
  await cleanupTemporaryDirs();
  await rm(checkDirectory, { recursive: true, force: true });
});

describe("generated Pi extensions", () => {
  it("typecheck against the installed Pi extension API", { timeout: 120_000 }, async () => {
    const files = await writeGeneratedExtensions();

    expect(files).toHaveLength(5);
    expect(typeCheck(files)).toEqual([]);
  });

  it("report a Pi API mismatch", { timeout: 120_000 }, async () => {
    const files = await writeGeneratedExtensions();
    const edited = path.join(checkDirectory, "drifted.ts");
    await writeFile(
      edited,
      `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function drifted(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setFooter("not a factory");
  });
}
`,
      "utf8"
    );

    expect(typeCheck([...files, edited]).length).toBeGreaterThan(0);
  });
});

async function writeGeneratedExtensions(): Promise<readonly string[]> {
  const stateDir = await makeTemporaryDir("localpi-extension-types");
  await mkdir(checkDirectory, { recursive: true });
  const options = {
    ...parseLocalpiArgs([
      "--state-dir",
      stateDir,
      "--session-dir",
      path.join(stateDir, "sessions"),
      "--continue-on-truncation",
      "2"
    ]),
    stats: "full" as const
  };
  const bundle = await writeDefaultExtensions(options, {
    engines: [{ provider: "llama-cpp", engine: "llama.cpp" }]
  });

  const files: string[] = [];
  for (const source of bundle.paths) {
    const target = path.join(checkDirectory, path.basename(source));
    await writeFile(target, await readFile(source, "utf8"), "utf8");
    files.push(target);
  }
  return files;
}

function typeCheck(rootNames: readonly string[]): readonly string[] {
  const program = ts.createProgram({
    rootNames: [...rootNames],
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      lib: ["lib.es2022.d.ts"],
      types: ["node"],
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      noEmit: true
    }
  });

  return ts.getPreEmitDiagnostics(program).map(describeDiagnostic);
}

function describeDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return message;
  }
  const line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
  return `${path.basename(diagnostic.file.fileName)}:${String(line)} ${message}`;
}
