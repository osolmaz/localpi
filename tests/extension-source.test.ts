import ts from "typescript";
import { describe, expect, it } from "vitest";

import { continueOnTruncationExtensionSource } from "../src/pi/extension-sources/continue-on-truncation.js";
import { startupModelSelectorExtensionSource } from "../src/pi/extension-sources/startup-model-selector.js";
import { statusLineExtensionSource } from "../src/pi/extension-sources/status-line.js";
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
      fileName: "continue-on-truncation.ts",
      source: continueOnTruncationExtensionSource(2)
    },
    {
      fileName: "thinking-control.ts",
      source: thinkingControlExtensionSource("/tmp/localpi/settings.json")
    },
    {
      fileName: "tool-approval.ts",
      source: approvalExtensionSource({
        enabled: true,
        settingsPath: "/tmp/localpi/settings.json",
        approveReadTools: false
      })
    },
    {
      fileName: "token-status.ts",
      source: tokenStatusExtensionSource({
        settingsPath: "/tmp/localpi/settings.json",
        mode: "full",
        engine: "llama-cpp",
        baseUrl: "http://127.0.0.1:8080/v1",
        modelId: "local-model"
      })
    },
    {
      fileName: "status-line.ts",
      source: statusLineExtensionSource({
        engines: [{ provider: "llama-cpp", engine: "llama.cpp" }]
      })
    }
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
});

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return diagnostics
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    .join("\n");
}
