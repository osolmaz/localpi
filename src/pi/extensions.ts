import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LocalpiOptions } from "../localpi/options.js";

export type ExtensionBundle = {
  readonly paths: readonly string[];
  readonly systemPrompt: string;
};

export async function writeDefaultExtensions(options: LocalpiOptions): Promise<ExtensionBundle> {
  const extensionDir = path.join(options.stateDir, "pi-extensions");
  await mkdir(extensionDir, { recursive: true });
  const paths: string[] = [];
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
  estimatedOutputTokens: number;
  lastStatusAt: number;
};

export default function localpiTokenStatus(pi: ExtensionAPI): void {
  const turns = new Map<number, TurnState>();

  pi.on("turn_start", (event) => {
    turns.set(event.turnIndex, {
      startedAt: Date.now(),
      estimatedOutputTokens: 0,
      lastStatusAt: 0
    });
  });

  pi.on("message_update", (event, ctx) => {
    const state = turns.get(event.turnIndex);
    if (!ctx.hasUI || state === undefined) {
      return;
    }
    const text = textFromUnknown(event.assistantMessageEvent ?? event.message ?? event);
    state.estimatedOutputTokens = Math.max(state.estimatedOutputTokens, Math.ceil(text.length / 4));
    if (Date.now() - state.lastStatusAt < 250) {
      return;
    }
    state.lastStatusAt = Date.now();
    ctx.ui.setStatus("localpi-perf", ctx.ui.theme.fg("dim", statusText(state)));
  });

  pi.on("turn_end", (event, ctx) => {
    const state = turns.get(event.turnIndex) ?? {
      startedAt: Date.now(),
      estimatedOutputTokens: 0,
      lastStatusAt: 0
    };
    turns.delete(event.turnIndex);

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

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const delta = object["delta"];
    const text = object["text"] ?? object["content"];
    if (typeof delta === "string") {
      return delta;
    }
    if (typeof text === "string") {
      return text;
    }
  }
  return "";
}
`;
}
