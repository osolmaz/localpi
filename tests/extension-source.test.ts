import ts from "typescript";
import { describe, expect, it } from "vitest";

import { startupModelSelectorExtensionSource } from "../src/pi/extension-sources/startup-model-selector.js";
import { thinkingControlExtensionSource } from "../src/pi/extension-sources/thinking-control.js";
import { tokenStatusExtensionSource } from "../src/pi/extension-sources/token-status.js";
import { approvalExtensionSource } from "../src/pi/extension-sources/tool-approval.js";

describe("generated Pi extension sources", () => {
  const sources = [
    {
      fileName: "startup-model-selector.ts",
      source: startupModelSelectorExtensionSource({
        models: [{ provider: "lmstudio", id: "gemma" }]
      })
    },
    {
      fileName: "thinking-control.ts",
      source: thinkingControlExtensionSource("/tmp/localpi/settings.json")
    },
    { fileName: "tool-approval.ts", source: approvalExtensionSource() },
    { fileName: "token-status.ts", source: tokenStatusExtensionSource() }
  ] as const;

  for (const { fileName, source } of sources) {
    it(`transpiles ${fileName}`, () => {
      const result = ts.transpileModule(source, {
        fileName,
        reportDiagnostics: true,
        compilerOptions: {
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          target: ts.ScriptTarget.ES2022,
          strict: true
        }
      });
      expect(formatDiagnostics(result.diagnostics ?? [])).toBe("");
    });
  }

  it("token status omits the context segment when includeContext is false", () => {
    expect(tokenStatusExtensionSource({ includeContext: false })).toContain(
      "const includeContext = false;"
    );
    expect(tokenStatusExtensionSource()).toContain("const includeContext = true;");
  });
});

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return diagnostics
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    .join("\n");
}
