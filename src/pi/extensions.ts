import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LocalpiOptions } from "../localpi/options.js";
import { thinkingStatePath } from "../localpi/thinking-state.js";
import { resolveDemoPrompts, type DemoPrompts } from "./demo.js";

export type ExtensionBundle = {
  readonly paths: readonly string[];
  readonly systemPrompt: string;
};

export type ExtensionOptions = {
  readonly startupModelSelector?: StartupModelSelectorOptions;
};

export type StartupModelSelectorOptions = {
  readonly models: readonly StartupModelSelectorModel[];
};

export type StartupModelSelectorModel = {
  readonly provider: string;
  readonly id: string;
};

export async function writeDefaultExtensions(
  options: LocalpiOptions,
  extensionOptions: ExtensionOptions = {}
): Promise<ExtensionBundle> {
  const extensionDir = path.join(options.stateDir, "pi-extensions");
  await mkdir(extensionDir, { recursive: true });
  const paths: string[] = [];
  if (extensionOptions.startupModelSelector !== undefined) {
    paths.push(
      await writeExtension(
        extensionDir,
        "startup-model-selector.ts",
        startupModelSelectorExtensionSource(extensionOptions.startupModelSelector)
      )
    );
  }
  if (options.demo) {
    paths.push(
      await writeExtension(
        extensionDir,
        "demo-mode.ts",
        demoModeExtensionSource(await resolveDemoPrompts(options))
      )
    );
  }
  paths.push(
    await writeExtension(
      extensionDir,
      "thinking-control.ts",
      thinkingControlExtensionSource(thinkingStatePath(options))
    )
  );
  if (options.approval) {
    paths.push(await writeExtension(extensionDir, "tool-approval.ts", approvalExtensionSource()));
  }
  if (options.tokenStatus) {
    paths.push(await writeExtension(extensionDir, "token-status.ts", tokenStatusExtensionSource()));
  }
  return {
    paths,
    systemPrompt: localpiSystemPrompt(options.approval)
  };
}

async function writeExtension(extensionDir: string, name: string, source: string): Promise<string> {
  const extensionPath = path.join(extensionDir, name);
  await writeFile(extensionPath, source, "utf8");
  return extensionPath;
}

function demoModeExtensionSource(prompts: DemoPrompts): string {
  const initialPromptSource = JSON.stringify(prompts.initial);
  const followupPromptSource = JSON.stringify(prompts.followup);
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const initialPrompt = ${initialPromptSource};
const followupPrompt = ${followupPromptSource};

export default function localpiDemoMode(pi: ExtensionAPI): void {
  let started = false;
  let stopped = false;

  pi.on("session_start", (event, ctx) => {
    if (started || stopped || event.reason !== "startup" || ctx.mode !== "tui") {
      return;
    }
    started = true;
    queueMicrotask(() => {
      if (!stopped) {
        pi.sendUserMessage(initialPrompt);
      }
    });
  });

  pi.on("turn_end", (event, ctx) => {
    if (!started || stopped || ctx.mode !== "tui") {
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
    queueMicrotask(() => {
      if (!stopped) {
        pi.sendUserMessage(followupPrompt, { deliverAs: "followUp" });
      }
    });
  });

  pi.on("session_shutdown", () => {
    stopped = true;
  });
}
`;
}

function startupModelSelectorExtensionSource(options: StartupModelSelectorOptions): string {
  const startupModelsSource = JSON.stringify(options.models);
  return `import type { ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";

type SelectedModel = Parameters<ExtensionAPI["setModel"]>[0];
const startupModels = ${startupModelsSource} as const;
const startupModelKeys = new Set(startupModels.map((model) => modelKey(model)));

export default function localpiStartupModelSelector(pi: ExtensionAPI): void {
  let opened = false;

  pi.on("session_start", async (event, ctx) => {
    if (opened || event.reason !== "startup" || ctx.mode !== "tui") {
      return;
    }

    const selectableModels = startupAvailableModels(ctx.modelRegistry);
    if (selectableModels.length <= 1) {
      return;
    }
    const scopedModels = selectableModels.map((model) => ({ model }));

    opened = true;
    const selected = await ctx.ui.custom<SelectedModel | undefined>((tui, _theme, _keybindings, done) => {
      const settings = {
        setDefaultModelAndProvider: () => {}
      } as unknown as SettingsManager;
      return new ModelSelectorComponent(
        tui,
        ctx.model,
        settings,
        startupModelRegistry(ctx.modelRegistry) as typeof ctx.modelRegistry,
        scopedModels,
        (model) => done(model),
        () => done(undefined)
      );
    });

    if (selected === undefined) {
      return;
    }

    const ok = await pi.setModel(selected);
    if (!ok) {
      ctx.ui.notify(\`No API key for \${selected.provider}/\${selected.id}\`, "error");
    }
  });
}

function startupAvailableModels(registry: {
  getAvailable(): SelectedModel[];
}): SelectedModel[] {
  return registry.getAvailable().filter((model) => startupModelKeys.has(modelKey(model)));
}

function startupModelRegistry(registry: {
  refresh(): void;
  getError(): string | undefined;
  getAvailable(): SelectedModel[];
  find(provider: string, modelId: string): SelectedModel | undefined;
}): typeof registry {
  return {
    refresh: () => registry.refresh(),
    getError: () => registry.getError(),
    getAvailable: () => startupAvailableModels(registry),
    find: (provider, modelId) => {
      const model = registry.find(provider, modelId);
      return model !== undefined && startupModelKeys.has(modelKey(model)) ? model : undefined;
    }
  };
}

function modelKey(model: { readonly provider: string; readonly id: string }): string {
  return \`\${model.provider}\\u0000\${model.id}\`;
}
`;
}

function localpiSystemPrompt(approval: boolean): string {
  return [
    "You are running through localpi, a local Pi launcher for local models.",
    approval
      ? "Tool calls require user approval. If a tool result says it was blocked, denied, or requires approval, the tool did not run."
      : "Tool approval is disabled for this session.",
    "Do not claim that a blocked tool call ran.",
    "Prefer answering directly when tools are not needed."
  ].join("\n");
}

function approvalExtensionSource(): string {
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function localpiToolApproval(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt:
      event.systemPrompt +
      "\\n\\nTool approval rule: if any tool result says the tool was blocked, denied, or requires approval, the tool did not run. Do not claim blocked tools ran."
  }));

  pi.on("tool_call", async (event, ctx) => {
    const input = formatInput(event.input);

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: \`Tool call "\${event.toolName}" was blocked and did not run because interactive approval is required.\`
      };
    }

    const ok = await ctx.ui.confirm(\`Allow tool call: \${event.toolName}?\`, input);
    if (!ok) {
      return { block: true, reason: "Tool call was blocked by the user and did not run." };
    }

    return undefined;
  });
}

function formatInput(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input, null, 2);
  } catch {
    text = String(input);
  }

  const maxLength = 4000;
  if (text.length <= maxLength) {
    return text;
  }
  return \`\${text.slice(0, maxLength)}\\n... truncated ...\`;
}
`;
}

function tokenStatusExtensionSource(): string {
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
};

type TurnState = {
  startedAt: number;
  outputText: string;
  estimatedOutputTokens: number;
  lastStatusAt: number;
};

export default function localpiTokenStatus(pi: ExtensionAPI): void {
  let currentTurn: TurnState | undefined;

  pi.on("turn_start", () => {
    currentTurn = {
      startedAt: Date.now(),
      outputText: "",
      estimatedOutputTokens: 0,
      lastStatusAt: 0
    };
  });

  pi.on("message_update", (event, ctx) => {
    const state = currentTurn;
    if (!ctx.hasUI || state === undefined) {
      return;
    }
    const update = textUpdateFromUnknown(event.assistantMessageEvent ?? event.message ?? event);
    if (update.kind === "delta") {
      state.outputText += update.text;
    } else if (update.text.length > state.outputText.length) {
      state.outputText = update.text;
    }
    state.estimatedOutputTokens = Math.ceil(state.outputText.length / 4);
    if (Date.now() - state.lastStatusAt < 250) {
      return;
    }
    state.lastStatusAt = Date.now();
    ctx.ui.setStatus("localpi-perf", ctx.ui.theme.fg("dim", statusText(state)));
  });

  pi.on("turn_end", (event, ctx) => {
    const state = currentTurn ?? {
      startedAt: Date.now(),
      outputText: "",
      estimatedOutputTokens: 0,
      lastStatusAt: 0
    };
    currentTurn = undefined;

    if (!ctx.hasUI || event.message.role !== "assistant") {
      return;
    }

    const usage = event.message.usage as Usage | undefined;
    const output = usage?.output ?? state.estimatedOutputTokens;
    const input = usage?.input ?? 0;
    const cacheRead = usage?.cacheRead ?? 0;
    const cacheWrite = usage?.cacheWrite ?? 0;
    const elapsedSeconds = elapsed(state);
    const context = ctx.getContextUsage();
    const contextText =
      context && context.percent !== null
        ? \`ctx \${Math.round(context.percent)}%/\${Math.round(context.contextWindow / 1000)}k\`
        : "ctx ?";

    ctx.ui.setStatus(
      "localpi-perf",
      ctx.ui.theme.fg(
        "dim",
        [
          \`\${(output / elapsedSeconds).toFixed(1)} tok/s\`,
          \`out \${output}\`,
          \`in \${input}\`,
          cacheRead > 0 ? \`cache \${cacheRead}\` : undefined,
          cacheWrite > 0 ? \`cw \${cacheWrite}\` : undefined,
          \`\${elapsedSeconds.toFixed(1)}s\`,
          contextText
        ]
          .filter(Boolean)
          .join(" | ")
      )
    );
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("localpi-perf", "");
    }
  });
}

function statusText(state: TurnState): string {
  const elapsedSeconds = elapsed(state);
  return \`\${(state.estimatedOutputTokens / elapsedSeconds).toFixed(1)} tok/s | out ~\${state.estimatedOutputTokens} | \${elapsedSeconds.toFixed(1)}s\`;
}

function elapsed(state: TurnState): number {
  return Math.max((Date.now() - state.startedAt) / 1000, 0.001);
}

type TextUpdate = {
  kind: "delta" | "snapshot";
  text: string;
};

function textUpdateFromUnknown(value: unknown): TextUpdate {
  if (typeof value === "string") {
    return { kind: "snapshot", text: value };
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const delta = object["delta"];
    const text = object["text"] ?? object["content"];
    if (typeof delta === "string") {
      return { kind: "delta", text: delta };
    }
    if (typeof text === "string") {
      return { kind: "snapshot", text };
    }
  }
  return { kind: "snapshot", text: "" };
}
`;
}

function thinkingControlExtensionSource(statePath: string): string {
  const statePathSource = JSON.stringify(statePath);
  return `import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const levels: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const statePath = ${statePathSource};

export default function localpiThinkingControl(pi: ExtensionAPI): void {
  pi.registerCommand("thinking", {
    description: "Set localpi thinking level",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trim().toLowerCase();
      const matches = levels.filter((level) => level.startsWith(trimmed));
      return matches.length === 0 ? null : matches.map((level) => ({ value: level, label: level }));
    },
    handler: async (args, ctx) => {
      const requested = parseThinkingLevel(args);
      const level = requested ?? (await promptThinkingLevel(pi.getThinkingLevel(), ctx));
      if (level === undefined) {
        return;
      }
      pi.setThinkingLevel(level);
      const actual = pi.getThinkingLevel();
      await persistThinking(actual);
      ctx.ui.notify(
        actual === level ? \`thinking: \${actual}\` : \`thinking: \${actual} (clamped from \${level})\`,
        actual === level ? "info" : "warning"
      );
    }
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    await persistThinking(event.level);
    ctx.ui.setStatus("localpi-thinking", \`thinking: \${event.level}\`);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await persistThinking(pi.getThinkingLevel());
    ctx.ui.setStatus("localpi-thinking", undefined);
  });
}

async function persistThinking(level: ThinkingLevel): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, \`\${JSON.stringify({ thinking: level }, null, 2)}\\n\`, "utf8");
}

async function promptThinkingLevel(
  current: ThinkingLevel,
  ctx: { readonly ui: { select(title: string, options: string[]): Promise<string | undefined> } }
): Promise<ThinkingLevel | undefined> {
  const selected = await ctx.ui.select(
    "Thinking level",
    levels.map((level) => (level === current ? \`\${level} (current)\` : level))
  );
  return selected === undefined ? undefined : parseThinkingLevel(selected);
}

function parseThinkingLevel(value: string): ThinkingLevel | undefined {
  const normalized = value.trim().split(/\\s+/u)[0]?.toLowerCase();
  return levels.find((level) => level === normalized);
}
`;
}
