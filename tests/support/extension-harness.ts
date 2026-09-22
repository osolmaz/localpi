import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

const temporaryDirs: string[] = [];

export async function makeTemporaryDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

export async function cleanupTemporaryDirs(): Promise<void> {
  await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  temporaryDirs.length = 0;
}

export type GeneratedExtension = (pi: unknown) => void;

/**
 * Load a generated localpi extension the same way Pi does: transpile the TypeScript source, then
 * import the emitted JavaScript module.
 */
export async function loadGeneratedExtension(source: string): Promise<GeneratedExtension> {
  const dir = await makeTemporaryDir("localpi-extension-");
  const file = path.join(dir, "extension.mjs");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  await writeFile(file, transpiled, "utf8");
  const module = (await import(pathToFileURL(file).href)) as { readonly default: unknown };
  if (typeof module.default !== "function") {
    throw new Error("generated extension has no default export");
  }
  return module.default as GeneratedExtension;
}
