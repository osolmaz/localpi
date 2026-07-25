import type { DemoPrompts } from "../demo.js";

export function demoModeExtensionSource(prompts: DemoPrompts): string {
  const initialPromptSource = JSON.stringify(prompts.initial);
  const followupPromptSource = JSON.stringify(prompts.followup);
  return `import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";

const initialPrompt = ${initialPromptSource};
const followupPrompt = ${followupPromptSource};
const compactAtContextPercent = 70;
const demoCompactionInstructions = [
  "Preserve the demo narrative state, named entities, current setting,",
  "unresolved plot threads, and latest user direction.",
  "Keep the summary concise so the story can continue after compaction."
].join(" ");

// Demo chrome: recordings only need the chat and the perf status line, so the
// footer is replaced with a single dim line (extension statuses + model name)
// and the input editor is hidden. The built-in footer's cwd and context lines
// are intentionally dropped.
type DemoFooterTheme = { fg(color: string, text: string): string };
type DemoFooterData = { getExtensionStatuses(): ReadonlyMap<string, string> };
type DemoFooterComponent = { render(width: number): string[] };
type DemoChromeUi = {
  setFooter(
    factory:
      | ((tui: unknown, theme: DemoFooterTheme, footerData: DemoFooterData) => DemoFooterComponent)
      | undefined
  ): void;
  setEditorComponent(
    factory: ((tui: unknown, theme: unknown, keybindings: unknown) => unknown) | undefined
  ): void;
};

const ansiPattern = new RegExp(String.fromCharCode(27) + "\\\\[[0-9;]*m", "gu");

function visibleLength(text: string): number {
  return text.replace(ansiPattern, "").length;
}

function demoFooterLines(left: string, right: string, width: number): string[] {
  const leftWidth = visibleLength(left);
  const rightWidth = visibleLength(right);
  if (left === "") {
    return [" ".repeat(Math.max(0, width - rightWidth)) + right];
  }
  if (leftWidth + 2 + rightWidth <= width) {
    return [left + " ".repeat(width - leftWidth - rightWidth) + right];
  }
  return [left, " ".repeat(Math.max(0, width - rightWidth)) + right];
}

function applyDemoChrome(ctx: ExtensionContext): void {
  const ui = ctx.ui as unknown as Partial<DemoChromeUi>;
  if (typeof ui.setFooter !== "function" || typeof ui.setEditorComponent !== "function") {
    return;
  }
  const modelName = ctx.model?.id ?? "";
  ui.setFooter((_tui, theme, footerData) => ({
    render(width: number): string[] {
      const left = Array.from(footerData.getExtensionStatuses().entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => text.replace(/[\\r\\n\\t]+/gu, " ").trim())
        .filter((text) => text !== "")
        .join(" ");
      return demoFooterLines(left, theme.fg("dim", modelName), width);
    }
  }));
  void hideEditor(ui as DemoChromeUi);
}

async function hideEditor(ui: DemoChromeUi): Promise<void> {
  try {
    const pkg = (await import("@earendil-works/pi-coding-agent")) as unknown as {
      CustomEditor: new (
        tui: unknown,
        theme: unknown,
        keybindings: unknown
      ) => { render(width: number): string[] };
    };
    class HiddenEditor extends pkg.CustomEditor {
      override render(): string[] {
        return [];
      }
    }
    ui.setEditorComponent((tui, theme, keybindings) => new HiddenEditor(tui, theme, keybindings));
  } catch {
    // Keep the default editor when the package cannot be imported (e.g. the
    // extension is loaded outside Pi's module loader in tests).
  }
}

export default function localpiDemoMode(pi: ExtensionAPI): void {
  let started = false;
  let stopped = false;
  let compacting = false;

  function queueInitialPrompt(): void {
    queueMicrotask(() => {
      if (!stopped) {
        pi.sendUserMessage(initialPrompt);
      }
    });
  }

  function queueFollowup(): void {
    queueMicrotask(() => {
      if (!stopped && !compacting) {
        pi.sendUserMessage(followupPrompt, { deliverAs: "followUp" });
      }
    });
  }

  function compactThenFollowup(ctx: ExtensionContext): void {
    if (compacting) {
      return;
    }
    compacting = true;
    ctx.compact({
      customInstructions: demoCompactionInstructions,
      onComplete: () => {
        compacting = false;
        queueFollowup();
      },
      onError: (error) => {
        compacting = false;
        stopped = true;
        ctx.ui.notify("Demo compaction failed: " + error.message, "error");
      }
    });
  }

  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui") {
      return;
    }
    applyDemoChrome(ctx);
    if (started || stopped || event.reason !== "startup") {
      return;
    }
    started = true;
    queueInitialPrompt();
  });

  pi.on("turn_end", (event, ctx) => {
    if (!started || stopped || compacting || ctx.mode !== "tui") {
      return;
    }
    if (event.message.role !== "assistant") {
      return;
    }
    switch (event.message.stopReason) {
      case "aborted":
      case "error":
        stopped = true;
        return;
      case "toolUse":
        return;
    }
    if (shouldCompactBeforeFollowup(event, ctx)) {
      compactThenFollowup(ctx);
      return;
    }
    queueFollowup();
  });

  pi.on("session_shutdown", () => {
    stopped = true;
  });
}

function shouldCompactBeforeFollowup(event: TurnEndEvent, ctx: ExtensionContext): boolean {
  const contextPercent = currentContextPercent(event, ctx);
  return contextPercent !== undefined && contextPercent >= compactAtContextPercent;
}

function currentContextPercent(event: TurnEndEvent, ctx: ExtensionContext): number | undefined {
  const usage = ctx.getContextUsage();
  if (usage?.percent !== undefined && usage.percent !== null) {
    return usage.percent;
  }
  if (event.message.role !== "assistant") {
    return undefined;
  }
  const contextWindow = ctx.model?.contextWindow;
  if (contextWindow === undefined || contextWindow <= 0) {
    return undefined;
  }
  return (event.message.usage.totalTokens / contextWindow) * 100;
}
`;
}
