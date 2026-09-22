import type { EngineEntry } from "../../localpi/provider-registry.js";

export type StatusLineConfig = {
  readonly engines?: readonly EngineEntry[];
};

/**
 * Pi renders its own footer in two lines and never shows which engine serves the
 * model. Localpi replaces the footer with one line that carries the same facts
 * plus the engine label next to the model. The live turn numbers stay in the
 * working line, so no number appears on screen twice at the same time.
 */
export function statusLineExtensionSource(config: StatusLineConfig): string {
  const enginesSource = JSON.stringify(config.engines ?? []);
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type EngineEntry = {
  provider: string;
  engine: string;
};

type Segment = {
  text: string;
  color: string;
};

// The stats extension publishes the last completed turn to this typed global, so the status line
// can keep showing the rate after the working line disappears. A missing bridge hides the rate only.
type TurnSummary = { readonly rate?: number | undefined };
type StatsBridge = { lastTurn?: TurnSummary | undefined };

type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};

type EntryLike = {
  type?: string;
  usage?: UsageLike;
  message?: { role?: string; usage?: UsageLike };
};

type ContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

type StatusModel = {
  readonly id?: string;
  readonly provider?: string;
  readonly reasoning?: boolean;
  readonly contextWindow?: number;
};

type StatusContext = {
  readonly mode: string;
  readonly cwd: string;
  readonly model?: StatusModel | undefined;
  readonly thinkingLevel?: string | undefined;
  readonly sessionManager: {
    getEntries(): readonly EntryLike[];
    getCwd(): string;
    getSessionName(): string | undefined;
  };
  getContextUsage(): ContextUsage | undefined;
  isIdle?(): boolean;
  readonly ui: { setFooter(factory: unknown): void };
};

type FooterData = {
  // Pi types this as string | null, so accept every absent-branch shape.
  getGitBranch(): string | null | undefined;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  onBranchChange(callback: () => void): () => void;
};
type TuiLike = { requestRender(): void };
type ThemeLike = { fg(color: string, text: string): string };

type GroupKey = "location" | "totals" | "rate" | "context" | "statuses";

type Group = {
  key: GroupKey;
  segments: Segment[];
};

const engines: readonly EngineEntry[] = ${enginesSource};
const minPadding = 2;
const groupJoiner = " \\u00b7 ";
const segmentJoiner = " ";
// The rate is the least important group, so it goes first when the line is too narrow.
const dropOrder: readonly GroupKey[] = ["rate", "location", "statuses", "totals"];

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") {
      return;
    }
    ctx.ui.setFooter((tui: TuiLike, theme: ThemeLike, footerData: FooterData) => {
      const unsubscribe = footerData.onBranchChange(() => {
        tui.requestRender();
      });
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          return renderFooter(width, ctx, footerData, theme);
        }
      };
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") {
      return;
    }
    ctx.ui.setFooter(undefined);
  });
}

function renderFooter(
  width: number,
  ctx: StatusContext,
  footerData: FooterData,
  theme: ThemeLike
): string[] {
  const right = rightGroups(ctx);
  const left = fit(width, leftGroups(ctx, footerData), right);
  const leftBudget = width - minPadding - groupsWidth(right);
  const fittedLeft = groupsWidth(left) > leftBudget ? truncateGroups(left, leftBudget) : left;
  const leftWidth = groupsWidth(fittedLeft);
  const rightBudget = width - leftWidth - minPadding;
  const fittedRight = groupsWidth(right) > rightBudget ? truncateGroups(right, rightBudget) : right;
  const rightWidth = groupsWidth(fittedRight);
  const padding = " ".repeat(Math.max(minPadding, width - leftWidth - rightWidth));
  return [paintGroups(fittedLeft, theme) + padding + paintGroups(fittedRight, theme)];
}

function leftGroups(ctx: StatusContext, footerData: FooterData): Group[] {
  const groups: Group[] = [];
  const location = locationText(ctx, footerData);
  if (location.length > 0) {
    groups.push({ key: "location", segments: [{ text: location, color: "dim" }] });
  }
  const totals = totalsGroup(ctx);
  if (totals.length > 0) {
    groups.push({ key: "totals", segments: totals });
  }
  const rate = rateGroup(ctx);
  if (rate.length > 0) {
    groups.push({ key: "rate", segments: rate });
  }
  const context = contextGroup(ctx);
  if (context.length > 0) {
    groups.push({ key: "context", segments: context });
  }
  const statuses = statusesGroup(footerData);
  if (statuses.length > 0) {
    groups.push({ key: "statuses", segments: statuses });
  }
  return groups;
}

function fit(width: number, groups: Group[], right: Group[]): Group[] {
  let current = groups;
  for (const key of dropOrder) {
    if (groupsWidth(current) + minPadding + groupsWidth(right) <= width) {
      return current;
    }
    current = current.filter((group) => group.key !== key);
  }
  return current;
}

function locationText(ctx: StatusContext, footerData: FooterData): string {
  const branch = footerData.getGitBranch();
  const name = ctx.sessionManager.getSessionName();
  let text = homeRelative(ctx.sessionManager.getCwd() || ctx.cwd);
  // Pi types these as optional strings, but an absent branch or name can arrive as null.
  if (typeof branch === "string" && branch.length > 0) {
    text = text + " (" + branch + ")";
  }
  if (typeof name === "string" && name.length > 0) {
    text = text + " \\u2022 " + name;
  }
  return text;
}

function homeRelative(cwd: string): string {
  const home = process.env["HOME"];
  if (home === undefined || home.length === 0) {
    return cwd;
  }
  if (cwd === home) {
    return "~";
  }
  return cwd.startsWith(home + "/") ? "~" + cwd.slice(home.length) : cwd;
}

function totalsGroup(ctx: StatusContext): Segment[] {
  const totals = totalsOf(ctx.sessionManager.getEntries());
  const segments: Segment[] = [];
  if (totals.input > 0) {
    segments.push({ text: "\\u2191" + formatTokens(totals.input), color: "dim" });
  }
  if (totals.output > 0) {
    segments.push({ text: "\\u2193" + formatTokens(totals.output), color: "dim" });
  }
  if (totals.cacheRead > 0) {
    segments.push({ text: "R" + formatTokens(totals.cacheRead), color: "dim" });
  }
  if (totals.cacheWrite > 0) {
    segments.push({ text: "W" + formatTokens(totals.cacheWrite), color: "dim" });
  }
  if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && totals.cacheHitRate !== undefined) {
    segments.push({ text: "CH" + totals.cacheHitRate.toFixed(1) + "%", color: "dim" });
  }
  if (totals.cost > 0) {
    segments.push({ text: "$" + totals.cost.toFixed(3), color: "dim" });
  }
  return segments;
}

function rateGroup(ctx: StatusContext): Segment[] {
  // The working line shows the live rate while the model runs, so the footer keeps the rate of the
  // last completed turn, and only while the model is idle.
  if (ctx.isIdle?.() !== true) {
    return [];
  }
  const holder = globalThis as unknown as { localpiStats?: StatsBridge };
  const rate = holder.localpiStats?.lastTurn?.rate;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    return [];
  }
  return [{ text: formatRate(rate), color: "muted" }];
}

function formatRate(rate: number): string {
  const fixed = Number(rate.toFixed(1));
  return (fixed < 100 ? fixed.toFixed(1) : String(Math.round(fixed))) + " tok/s";
}

function contextGroup(ctx: StatusContext): Segment[] {
  // The working line shows the context while the model runs, so the footer shows it only when idle.
  if (ctx.isIdle?.() === false) {
    return [];
  }
  const usage = ctx.getContextUsage();
  const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  if (window <= 0) {
    return [];
  }
  const percent = usage?.percent;
  const text =
    percent === undefined || percent === null
      ? "?/" + formatTokens(window)
      : percent.toFixed(1) + "%/" + formatTokens(window);
  return [{ text, color: contextColor(percent) }];
}

function statusesGroup(footerData: FooterData): Segment[] {
  const entries = Array.from(footerData.getExtensionStatuses().entries()).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const text = entries
    .map(([, value]) => (typeof value === "string" ? sanitize(value) : ""))
    .filter((value) => value.length > 0)
    .join(" \\u00b7 ");
  return text.length === 0 ? [] : [{ text, color: "muted" }];
}

function rightGroups(ctx: StatusContext): Group[] {
  const model = ctx.model;
  const id = model?.id ?? "no-model";
  let text = id;
  if (model?.reasoning === true) {
    const level = ctx.thinkingLevel ?? "off";
    text = level === "off" ? text + " \\u2022 thinking off" : text + " \\u2022 " + level;
  }
  const segments: Segment[] = [{ text, color: "dim" }];
  const engine = engineLabel(model?.provider);
  if (engine !== undefined) {
    segments.unshift({ text: "(" + engine + ")", color: "muted" });
  }
  return [{ key: "context", segments }];
}

function engineLabel(provider: string | undefined): string | undefined {
  return engines.find((entry) => entry.provider === provider)?.engine;
}

function totalsOf(entries: readonly EntryLike[]): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  cacheHitRate?: number;
} {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let cacheHitRate: number | undefined;
  for (const entry of entries) {
    const usage = usageOf(entry);
    if (usage === undefined) {
      continue;
    }
    totals.input += numberOrZero(usage.input);
    totals.output += numberOrZero(usage.output);
    totals.cacheRead += numberOrZero(usage.cacheRead);
    totals.cacheWrite += numberOrZero(usage.cacheWrite);
    totals.cost += numberOrZero(usage.cost?.total);
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const prompt =
        numberOrZero(usage.input) + numberOrZero(usage.cacheRead) + numberOrZero(usage.cacheWrite);
      cacheHitRate = prompt > 0 ? (numberOrZero(usage.cacheRead) / prompt) * 100 : undefined;
    }
  }
  return cacheHitRate === undefined ? totals : { ...totals, cacheHitRate };
}

function usageOf(entry: EntryLike): UsageLike | undefined {
  if (entry.type === "usage" || entry.type === "branch_summary" || entry.type === "compaction") {
    return entry.usage;
  }
  return entry.message?.usage;
}

function numberOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function contextColor(percent: number | null | undefined): string {
  if (percent === undefined || percent === null) {
    return "dim";
  }
  if (percent >= 95) {
    return "error";
  }
  return percent >= 80 ? "warning" : "dim";
}

function sanitize(text: string): string {
  return text.replace(/[\\u0000-\\u001f\\u007f]/gu, " ").trim();
}

function formatTokens(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  if (count < 10000) {
    return (count / 1000).toFixed(1) + "k";
  }
  if (count < 1000000) {
    return Math.round(count / 1000) + "k";
  }
  return count < 10000000 ? (count / 1000000).toFixed(1) + "M" : Math.round(count / 1000000) + "M";
}

function groupsWidth(groups: readonly Group[]): number {
  return plainText(groups).length;
}

function groupText(group: Group): string {
  return group.segments.map((segment) => segment.text).join(segmentJoiner);
}

function plainText(groups: readonly Group[]): string {
  return groups.map(groupText).join(groupJoiner);
}

function truncateGroups(groups: readonly Group[], width: number): Group[] {
  const result: Group[] = [];
  let used = 0;
  for (const group of groups) {
    const separator = result.length === 0 ? 0 : groupJoiner.length;
    const available = width - used - separator;
    if (available <= 0) {
      break;
    }
    const segments = truncateSegments(group.segments, available);
    if (segments.length === 0) {
      break;
    }
    result.push({ key: group.key, segments });
    used += separator + groupText({ key: group.key, segments }).length;
  }
  return result;
}

function truncateSegments(segments: readonly Segment[], width: number): Segment[] {
  const result: Segment[] = [];
  let used = 0;
  for (const segment of segments) {
    const separator = result.length === 0 ? 0 : segmentJoiner.length;
    const available = width - used - separator;
    if (available <= 0) {
      break;
    }
    const text = truncate(segment.text, available);
    if (text.length === 0) {
      break;
    }
    result.push({ text, color: segment.color });
    used += separator + text.length;
    if (text.length < segment.text.length) {
      break;
    }
  }
  return result;
}

function paintGroups(groups: readonly Group[], theme: ThemeLike): string {
  return groups
    .map((group) =>
      group.segments
        .map((segment) => theme.fg(segment.color, segment.text))
        .join(segmentJoiner)
    )
    .join(groupJoiner);
}

function truncate(text: string, width: number): string {
  const characters = Array.from(text);
  return characters.length <= width ? text : characters.slice(0, Math.max(0, width)).join("");
}
`;
}
