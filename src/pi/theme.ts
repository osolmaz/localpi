import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { catppuccinMocha } from "../common/catppuccin.js";

export const localpiThemeName = "catppuccin-mocha";

const themeSchema =
  "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json";

// Tool status cards need a dark surface with a visible success or failure cast. Both values are the
// Catppuccin base surface tinted with green and red.
const toolSuccessSurface = "#24352f";
const toolErrorSurface = "#3b2633";

export type PiThemeFile = {
  readonly $schema: string;
  readonly name: string;
  readonly vars: Readonly<Record<string, string>>;
  readonly colors: Readonly<Record<string, string>>;
  readonly export: {
    readonly pageBg: string;
    readonly cardBg: string;
    readonly infoBg: string;
  };
};

export function localpiThemePath(stateDir: string): string {
  return path.join(stateDir, "pi-themes", `${localpiThemeName}.json`);
}

export function localpiThemeArgs(
  themePath: string | undefined,
  forwardedArgs: readonly string[]
): readonly string[] {
  if (themePath === undefined) {
    return [];
  }
  // The theme file is always loaded, so /settings can offer it. Catppuccin is only selected when
  // the user did not ask for another theme in the same command line.
  return hasForwardedFlag(forwardedArgs, "--use-theme")
    ? ["--theme", themePath]
    : ["--theme", themePath, "--use-theme", localpiThemeName];
}

export async function writeLocalpiTheme(
  stateDir: string,
  forwardedArgs: readonly string[]
): Promise<string | undefined> {
  if (hasForwardedFlag(forwardedArgs, "--no-themes")) {
    return undefined;
  }
  const themePath = localpiThemePath(stateDir);
  await mkdir(path.dirname(themePath), { recursive: true });
  await writeFile(themePath, catppuccinThemeSource(), "utf8");
  return themePath;
}

export function catppuccinThemeSource(): string {
  return `${JSON.stringify(catppuccinTheme(), null, 2)}\n`;
}

export function catppuccinTheme(): PiThemeFile {
  return {
    $schema: themeSchema,
    name: localpiThemeName,
    vars: { ...catppuccinMocha },
    colors: {
      accent: "lavender",
      border: "surface2",
      borderAccent: "blue",
      borderMuted: "surface1",
      success: "green",
      error: "red",
      warning: "peach",
      muted: "subtext0",
      dim: "overlay1",
      text: "text",
      thinkingText: "overlay2",
      scrollbarTrack: "surface0",
      scrollbarThumb: "overlay1",
      selectedBg: "surface1",
      searchMatchBg: "surface2",
      searchMatchText: "text",
      userMessageBg: "surface0",
      userMessageText: "text",
      customMessageBg: "mantle",
      customMessageText: "text",
      customMessageLabel: "mauve",
      toolPendingBg: "mantle",
      toolSuccessBg: toolSuccessSurface,
      toolErrorBg: toolErrorSurface,
      toolTitle: "blue",
      toolOutput: "subtext0",
      mdHeading: "peach",
      mdLink: "blue",
      mdLinkUrl: "overlay1",
      mdCode: "teal",
      mdCodeBlock: "green",
      mdCodeBlockBorder: "surface2",
      mdQuote: "subtext0",
      mdQuoteBorder: "mauve",
      mdHr: "surface2",
      mdListBullet: "peach",
      toolDiffAdded: "green",
      toolDiffRemoved: "red",
      toolDiffContext: "overlay2",
      syntaxComment: "overlay1",
      syntaxKeyword: "mauve",
      syntaxFunction: "blue",
      syntaxVariable: "lavender",
      syntaxString: "green",
      syntaxNumber: "peach",
      syntaxType: "yellow",
      syntaxOperator: "sky",
      syntaxPunctuation: "overlay2",
      thinkingOff: "overlay0",
      thinkingMinimal: "overlay1",
      thinkingLow: "sapphire",
      thinkingMedium: "blue",
      thinkingHigh: "mauve",
      thinkingXhigh: "pink",
      thinkingMax: "red",
      bashMode: "green"
    },
    export: {
      pageBg: "#11111b",
      cardBg: "#1e1e2e",
      infoBg: "#313244"
    }
  };
}

function hasForwardedFlag(args: readonly string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}
