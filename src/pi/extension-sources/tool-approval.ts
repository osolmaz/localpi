export type ToolApprovalConfig = {
  readonly enabled: boolean;
};

export function approvalExtensionSource(config: ToolApprovalConfig): string {
  const initialEnabledSource = JSON.stringify(config.enabled);
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ApprovalState = "on" | "off";

type CommandContext = {
  readonly hasUI: boolean;
  readonly ui: {
    setStatus(key: string, text: string | undefined): void;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    select(title: string, options: string[]): Promise<string | undefined>;
  };
};

const approvalRule =
  "\\n\\nTool approval rule: if any tool result says the tool was blocked, denied, or requires approval, the tool did not run. Do not claim blocked tools ran.";
const states: readonly ApprovalState[] = ["on", "off"];
const statusKey = "localpi-approval";
// Approval is a session setting. The /approval command changes it for the current session only,
// so nothing here writes to the localpi settings file.
const initialEnabled: boolean = ${initialEnabledSource};

export default function localpiToolApproval(pi: ExtensionAPI): void {
  let enabled = initialEnabled;

  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + approvalRule
  }));

  pi.on("session_start", (_event, ctx) => {
    if (!enabled && ctx.hasUI) {
      ctx.ui.setStatus(statusKey, "approval: off");
    }
  });

  pi.registerCommand("approval", {
    description: "Turn the tool approval gate on or off for this session",
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trim().toLowerCase();
      const matches = states.filter((state) => state.startsWith(trimmed));
      return matches.length === 0 ? null : matches.map((state) => ({ value: state, label: state }));
    },
    handler: async (args: string, ctx: CommandContext) => {
      const requested = parseState(args);
      if (requested !== undefined) {
        apply(requested, ctx);
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("approval: " + label(enabled) + "; run localpi in a terminal to change it", "info");
        return;
      }
      const selected = await promptState(enabled, ctx);
      if (selected === undefined) {
        return;
      }
      apply(selected, ctx);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled) {
      return undefined;
    }

    const input = formatInput(event.input);

    if (!ctx.hasUI) {
      return {
        block: true,
        reason:
          'Tool call "' +
          event.toolName +
          '" was blocked and did not run because interactive approval is required.'
      };
    }

    const ok = await ctx.ui.confirm("Allow tool call: " + event.toolName + "?", input);
    if (!ok) {
      return { block: true, reason: "Tool call was blocked by the user and did not run." };
    }

    return undefined;
  });

  function apply(state: ApprovalState, ctx: CommandContext): void {
    enabled = state === "on";
    if (ctx.hasUI) {
      ctx.ui.setStatus(statusKey, enabled ? undefined : "approval: off");
    }
    ctx.ui.notify(
      enabled
        ? "approval: on; tool calls ask before they run"
        : "approval: off for this session; tool calls run without asking",
      enabled ? "info" : "warning"
    );
  }
}

function label(enabled: boolean): ApprovalState {
  return enabled ? "on" : "off";
}

function parseState(value: string): ApprovalState | undefined {
  const normalized = value.trim().split(/\\s+/u)[0]?.toLowerCase();
  return states.find((state) => state === normalized);
}

async function promptState(
  current: boolean,
  ctx: CommandContext
): Promise<ApprovalState | undefined> {
  const currentState = label(current);
  const selected = await ctx.ui.select(
    "Tool approval",
    states.map((state) => (state === currentState ? state + " (current)" : state))
  );
  return selected === undefined ? undefined : parseState(selected);
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
  return text.slice(0, maxLength) + "\\n... truncated ...";
}
`;
}
