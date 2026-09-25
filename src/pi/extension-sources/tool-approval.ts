import { settingsFileSource } from "./settings-file.js";

export type ToolApprovalConfig = {
  readonly enabled: boolean;
  readonly settingsPath: string;
  readonly approveReadTools: boolean;
};

export function approvalExtensionSource(config: ToolApprovalConfig): string {
  const initialEnabledSource = JSON.stringify(config.enabled);
  const approveReadToolsSource = JSON.stringify(config.approveReadTools);
  return `import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type PermissionMode = "ask" | "allow";

type CommandContext = {
  readonly hasUI: boolean;
  readonly ui: {
    setStatus(key: string, text: string | undefined): void;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    select(title: string, options: string[]): Promise<string | undefined>;
  };
};

const modes: readonly PermissionMode[] = ["ask", "allow"];
const aliases: readonly string[] = ["on", "off"];
// Read-only Pi tools cannot change the workspace, so the gate lets them run. bash is not in this
// list, because a bash command can write. An unknown tool also stays behind the gate.
const readOnlyTools: readonly string[] = ["read", "grep", "find", "ls"];
const statusKey = "localpi-approval";
const allowOnce = "Allow once";
const allowSession = "Allow all tools for this session";
const deny = "Deny and stop";
const blockedReason = "Tool call was blocked by the user and did not run.";
const noUiReason = " was blocked and did not run because interactive approval is required.";
// A deny stops the turn instead of letting the model try again. Pi terminates the turn when every
// blocked result in the tool batch asks for it, and a cancelled dialog counts as a deny.
// The permission setting is the launch default for new sessions. The /approval command writes it;
// the session-only choice in the tool call dialog never writes it.
${settingsFileSource(config.settingsPath)}
const initialEnabled: boolean = ${initialEnabledSource};
const gateReadTools: boolean = ${approveReadToolsSource};

export default function localpiToolApproval(pi: ExtensionAPI): void {
  let enabled = initialEnabled;

  pi.on("session_start", (_event, ctx) => {
    showStatus(ctx);
  });

  pi.registerCommand("approval", {
    description: "Choose whether tool calls ask for approval",
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trim().toLowerCase();
      const names = [...modes, ...aliases];
      const matches = names.filter((name) => name.startsWith(trimmed));
      return matches.length === 0 ? null : matches.map((name) => ({ value: name, label: name }));
    },
    handler: async (args: string, ctx: CommandContext) => {
      const requested = parseMode(args);
      if (requested !== undefined) {
        await apply(requested, ctx, true);
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(
          "permission: " + label(enabled) + "; run localpi in a terminal to change it",
          "info"
        );
        return;
      }
      const selected = await promptMode(enabled, ctx);
      if (selected === undefined) {
        return;
      }
      await apply(selected, ctx, true);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled) {
      return undefined;
    }

    if (!gateReadTools && readOnlyTools.includes(event.toolName)) {
      return undefined;
    }

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: 'Tool call "' + event.toolName + '"' + noUiReason,
        terminate: true
      };
    }

    const choice = await ctx.ui.select(
      "Allow tool call: " + event.toolName + "?\\n" + previewInput(event.input),
      [allowOnce, allowSession, deny]
    );

    if (choice === allowSession) {
      await apply("allow", ctx, false);
      return undefined;
    }

    if (choice !== allowOnce) {
      return { block: true, reason: blockedReason, terminate: true };
    }

    return undefined;
  });

  function showStatus(ctx: CommandContext): void {
    if (ctx.hasUI) {
      ctx.ui.setStatus(statusKey, enabled ? undefined : "permission: allow");
    }
  }

  async function apply(mode: PermissionMode, ctx: CommandContext, save: boolean): Promise<void> {
    enabled = mode === "ask";
    showStatus(ctx);
    ctx.ui.notify(notification(mode, save), enabled ? "info" : "warning");
    if (save) {
      await persist(mode);
    }
  }
}

function notification(mode: PermissionMode, save: boolean): string {
  const scope = save ? ", saved for new sessions" : " for this session";
  return mode === "ask"
    ? "permission: ask" + scope + "; tool calls ask before they run"
    : "permission: allow" + scope + "; tool calls run without asking";
}

async function persist(mode: PermissionMode): Promise<void> {
  const settings = await readSettings();
  settings["permission"] = mode;
  await writeSettings(settings);
}

function label(enabled: boolean): PermissionMode {
  return enabled ? "ask" : "allow";
}

function parseMode(value: string): PermissionMode | undefined {
  const normalized = value.trim().split(/\\s+/u)[0]?.toLowerCase();
  if (normalized === "on") {
    return "ask";
  }
  if (normalized === "off") {
    return "allow";
  }
  return modes.find((mode) => mode === normalized);
}

async function promptMode(
  current: boolean,
  ctx: CommandContext
): Promise<PermissionMode | undefined> {
  const currentMode = label(current);
  const selected = await ctx.ui.select(
    "Tool approval",
    modes.map((mode) => (mode === currentMode ? mode + " (current)" : mode))
  );
  return selected === undefined ? undefined : parseMode(selected);
}

function previewInput(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    text = String(input);
  }

  const maxLength = 1200;
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength) + "\\n... truncated ...";
}
`;
}
