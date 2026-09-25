import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { catppuccinPalettes, type CatppuccinFlavor } from "../localpi/catppuccin.js";

export const localpiThemeName = "catppuccin-mocha";

export function catppuccinThemeName(flavor: CatppuccinFlavor): string {
  return `catppuccin-${flavor}`;
}

const themeSchema =
  "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json";

// Tool status cards need a surface with a visible success or failure cast. Each value is the
// flavor's base surface tinted with green and red.
const toolSurfaces: Readonly<Record<CatppuccinFlavor, { success: string; error: string }>> = {
  latte: { success: "#dae9d6", error: "#f2d7dd" },
  frappe: { success: "#3c4a45", error: "#4b3d4a" },
  macchiato: { success: "#2f3d3e", error: "#42323f" },
  mocha: { success: "#24352f", error: "#3b2633" }
};

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

export function localpiThemePath(stateDir: string, flavor: CatppuccinFlavor = "mocha"): string {
  return path.join(stateDir, "pi-themes", `${catppuccinThemeName(flavor)}.json`);
}

export function localpiThemeArgs(
  themePath: string | readonly string[] | undefined,
  forwardedArgs: readonly string[],
  flavor: CatppuccinFlavor = "mocha"
): readonly string[] {
  if (themePath === undefined) {
    return [];
  }
  // The theme files are always loaded, so /settings, and web mode's theme setting, can offer them.
  // Catppuccin is only selected when the user did not ask for another theme on the command line.
  const paths = typeof themePath === "string" ? [themePath] : themePath;
  const load = paths.flatMap((entry) => ["--theme", entry]);
  return hasForwardedFlag(forwardedArgs, "--use-theme")
    ? load
    : [...load, "--use-theme", catppuccinThemeName(flavor)];
}

/**
 * Write the Pi theme of every given flavor, for web mode, whose theme setting switches the Pi theme
 * of running sessions. Returns undefined when the user turned Pi themes off.
 */
export async function writeLocalpiThemes(
  stateDir: string,
  forwardedArgs: readonly string[],
  flavors: readonly CatppuccinFlavor[]
): Promise<readonly string[] | undefined> {
  const paths: string[] = [];
  for (const flavor of flavors) {
    const written = await writeLocalpiTheme(stateDir, forwardedArgs, flavor);
    if (written === undefined) return undefined;
    paths.push(written);
  }
  return paths;
}

export async function writeLocalpiTheme(
  stateDir: string,
  forwardedArgs: readonly string[],
  flavor: CatppuccinFlavor = "mocha"
): Promise<string | undefined> {
  if (hasForwardedFlag(forwardedArgs, "--no-themes")) {
    return undefined;
  }
  const themePath = localpiThemePath(stateDir, flavor);
  await mkdir(path.dirname(themePath), { recursive: true });
  await writeFile(themePath, catppuccinThemeSource(flavor), "utf8");
  return themePath;
}

export function catppuccinThemeSource(flavor: CatppuccinFlavor = "mocha"): string {
  return `${JSON.stringify(catppuccinTheme(flavor), null, 2)}\n`;
}

export function catppuccinTheme(flavor: CatppuccinFlavor = "mocha"): PiThemeFile {
  const palette = catppuccinPalettes[flavor];
  return {
    $schema: themeSchema,
    name: catppuccinThemeName(flavor),
    vars: { ...palette },
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
      toolSuccessBg: toolSurfaces[flavor].success,
      toolErrorBg: toolSurfaces[flavor].error,
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
      pageBg: palette.crust,
      cardBg: palette.base,
      infoBg: palette.surface0
    }
  };
}

function hasForwardedFlag(args: readonly string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}
