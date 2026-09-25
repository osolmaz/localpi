import type { PiAppDefinition } from "@osolmaz/pi-factory";
import { runPiWebApp, type PiWebTheme, type PiWebThemeChoice } from "@osolmaz/pi-factory-web";

import {
  catppuccinFlavors,
  catppuccinPalettes,
  type CatppuccinColor,
  type CatppuccinFlavor
} from "../localpi/catppuccin.js";
import { catppuccinThemeName } from "./theme.js";
import type { LocalpiOptions } from "../localpi/options.js";

/**
 * The page and terminal colors for web mode, built from one Catppuccin palette. The terminal's
 * black and white follow the Catppuccin terminal ports, which swap them on the light flavor.
 */
export function localpiWebTheme(flavor: CatppuccinFlavor = "latte"): PiWebTheme {
  const c = catppuccinPalettes[flavor];
  const light = flavor === "latte";
  return {
    background: c.base,
    foreground: c.text,
    sidebarBackground: c.mantle,
    sidebarForeground: c.text,
    mutedForeground: c.subtext0,
    accent: c.mauve,
    selectedBackground: c.surface0,
    border: c.surface1,
    cursor: c.rosewater,
    selectionBackground: c.surface2,
    black: light ? c.subtext1 : c.surface1,
    red: c.red,
    green: c.green,
    yellow: c.yellow,
    blue: c.blue,
    magenta: c.pink,
    cyan: c.teal,
    white: light ? c.surface2 : c.subtext1,
    brightBlack: light ? c.subtext0 : c.surface2,
    brightRed: c.red,
    brightGreen: c.green,
    brightYellow: c.yellow,
    brightBlue: c.blue,
    brightMagenta: c.pink,
    brightCyan: c.teal,
    brightWhite: light ? c.surface1 : c.subtext0
  };
}

const flavorLabels: Readonly<Record<CatppuccinFlavor, string>> = {
  latte: "Catppuccin Latte",
  frappe: "Catppuccin Frappé",
  macchiato: "Catppuccin Macchiato",
  mocha: "Catppuccin Mocha"
};

const accentNames: readonly CatppuccinColor[] = [
  "rosewater",
  "flamingo",
  "pink",
  "mauve",
  "red",
  "maroon",
  "peach",
  "yellow",
  "green",
  "teal",
  "sky",
  "sapphire",
  "blue",
  "lavender"
];

/**
 * The theme choices for web mode's settings: every Catppuccin flavor, each with the Pi theme that
 * localpi writes for it, so a change in the page also switches Pi's theme in every session.
 */
export function localpiWebThemeChoices(piThemes = true): readonly PiWebThemeChoice[] {
  return catppuccinFlavors.map((flavor) => ({
    id: catppuccinThemeName(flavor),
    label: flavorLabels[flavor],
    theme: localpiWebTheme(flavor),
    accents: Object.fromEntries(
      accentNames.map((name) => [name, catppuccinPalettes[flavor][name]])
    ),
    // With Pi themes off (a forwarded --no-themes), Pi has no theme to switch to.
    ...(piThemes ? { piTheme: catppuccinThemeName(flavor) } : {})
  }));
}

/** Serve localpi in the browser until the process is stopped. */
export async function launchWebRuntime(
  app: PiAppDefinition,
  options: Pick<
    LocalpiOptions,
    "webPort" | "webOpen" | "webHost" | "webAllowedHosts" | "webTheme" | "forwardedArgs"
  >,
  run: typeof runPiWebApp = runPiWebApp
): Promise<number> {
  return await run(app, {
    host: options.webHost,
    allowedHosts: options.webAllowedHosts,
    port: options.webPort,
    open: options.webOpen,
    cwd: process.cwd(),
    themes: localpiWebThemeChoices(!options.forwardedArgs.includes("--no-themes")),
    defaultTheme: catppuccinThemeName(options.webTheme)
  });
}
