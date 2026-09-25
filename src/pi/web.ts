import type { PiAppDefinition } from "@osolmaz/pi-factory";
import { runPiWebApp, type PiWebTheme } from "@osolmaz/pi-factory-web";

import { catppuccinLatte } from "../localpi/catppuccin.js";
import type { LocalpiOptions } from "../localpi/options.js";

/** The page and terminal colors for web mode, built from the Latte palette. */
export function localpiWebTheme(): PiWebTheme {
  const c = catppuccinLatte;
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
    black: c.subtext1,
    red: c.red,
    green: c.green,
    yellow: c.yellow,
    blue: c.blue,
    magenta: c.pink,
    cyan: c.teal,
    white: c.surface2,
    brightBlack: c.subtext0,
    brightRed: c.red,
    brightGreen: c.green,
    brightYellow: c.yellow,
    brightBlue: c.blue,
    brightMagenta: c.pink,
    brightCyan: c.teal,
    brightWhite: c.surface1
  };
}

/** Serve localpi in the browser until the process is stopped. */
export async function launchWebRuntime(
  app: PiAppDefinition,
  options: Pick<LocalpiOptions, "webPort" | "webOpen" | "webHost" | "webAllowedHosts">,
  run: typeof runPiWebApp = runPiWebApp
): Promise<number> {
  return await run(app, {
    host: options.webHost,
    allowedHosts: options.webAllowedHosts,
    port: options.webPort,
    open: options.webOpen,
    cwd: process.cwd(),
    theme: localpiWebTheme()
  });
}
