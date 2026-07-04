export function tokenStatusExtensionSource(): string {
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
  firstOutputAt?: number;
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
    const now = Date.now();
    const update = textUpdateFromUnknown(event.assistantMessageEvent ?? event.message ?? event);
    if (update.kind === "delta") {
      state.outputText += update.text;
    } else if (update.text.length > state.outputText.length) {
      state.outputText = update.text;
    }
    state.estimatedOutputTokens = Math.ceil(state.outputText.length / 4);
    if (state.firstOutputAt === undefined && state.outputText.length > 0) {
      state.firstOutputAt = now;
    }
    if (now - state.lastStatusAt < 250) {
      return;
    }
    state.lastStatusAt = now;
    ctx.ui.setStatus("localpi-perf", ctx.ui.theme.fg("dim", statusText(state, now)));
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
    const now = Date.now();
    const elapsedSeconds = elapsed(state, now);
    const decodeSeconds = generationElapsed(state, now);
    const prefillText = prefillStatusText(state, input, cacheWrite);
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
          \`gen \${(output / decodeSeconds).toFixed(1)} tok/s\`,
          prefillText,
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

function statusText(state: TurnState, now: number): string {
  const elapsedSeconds = elapsed(state, now);
  if (state.firstOutputAt === undefined) {
    return \`prefill \${elapsedSeconds.toFixed(1)}s | out ~\${state.estimatedOutputTokens}\`;
  }
  const decodeSeconds = generationElapsed(state, now);
  const prefillSeconds = secondsBetween(state.startedAt, state.firstOutputAt);
  return [
    \`gen \${(state.estimatedOutputTokens / decodeSeconds).toFixed(1)} tok/s\`,
    \`out ~\${state.estimatedOutputTokens}\`,
    \`prefill \${prefillSeconds.toFixed(1)}s\`,
    \`total \${elapsedSeconds.toFixed(1)}s\`
  ].join(" | ");
}

function prefillStatusText(
  state: TurnState,
  input: number,
  cacheWrite: number
): string | undefined {
  const tokens = prefillTokenCount(input, cacheWrite);
  if (state.firstOutputAt === undefined || tokens <= 0) {
    return undefined;
  }
  const seconds = secondsBetween(state.startedAt, state.firstOutputAt);
  return \`prefill \${(tokens / seconds).toFixed(1)} tok/s\`;
}

function prefillTokenCount(input: number, cacheWrite: number): number {
  return Math.max(input + cacheWrite, 0);
}

function generationElapsed(state: TurnState, now: number): number {
  return secondsBetween(state.firstOutputAt ?? state.startedAt, now);
}

function elapsed(state: TurnState, now: number): number {
  return secondsBetween(state.startedAt, now);
}

function secondsBetween(start: number, end: number): number {
  return Math.max((end - start) / 1000, 0.001);
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
