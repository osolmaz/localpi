import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { catppuccinLatte, catppuccinMocha } from "../src/localpi/catppuccin.js";
import {
  catppuccinTheme,
  catppuccinThemeName,
  catppuccinThemeSource,
  localpiThemeArgs,
  localpiThemeName,
  localpiThemePath,
  writeLocalpiTheme
} from "../src/pi/theme.js";
import { cleanupTemporaryDirs, makeTemporaryDir } from "./support/extension-harness.js";

const requiredColorTokens = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "selectedBg",
  "scrollbarTrack",
  "scrollbarThumb",
  "userMessageBg",
  "userMessageText",
  "customMessageBg",
  "customMessageText",
  "customMessageLabel",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode"
] as const;

afterEach(async () => {
  await cleanupTemporaryDirs();
});

describe("localpi Catppuccin theme", () => {
  it("defines every Pi theme color token", () => {
    const theme = catppuccinTheme();

    expect(theme.name).toBe(localpiThemeName);
    for (const token of requiredColorTokens) {
      expect(theme.colors[token]).toBeDefined();
    }
  });

  it("resolves every color value from a palette variable or a hex color", () => {
    const theme = catppuccinTheme();
    const paletteNames = Object.keys(theme.vars);

    for (const [token, value] of Object.entries(theme.colors)) {
      const isPaletteName = paletteNames.includes(value);
      const isHexColor = /^#[0-9a-f]{6}$/u.test(value);
      expect(`${token}=${value}`).toBe(
        isPaletteName || isHexColor ? `${token}=${value}` : `${token}=unresolved`
      );
    }
  });

  it("uses Catppuccin Mocha values for the main surfaces", () => {
    const theme = catppuccinTheme();

    expect(theme.colors["accent"]).toBe("lavender");
    expect(theme.colors["text"]).toBe("text");
    expect(theme.colors["error"]).toBe("red");
    expect(theme.colors["warning"]).toBe("peach");
    expect(theme.colors["success"]).toBe("green");
    expect(theme.vars["base"]).toBe(catppuccinMocha.base);
    expect(theme.export.pageBg).toBe(catppuccinMocha.crust);
    expect(JSON.parse(catppuccinThemeSource())).toMatchObject({ name: localpiThemeName });
  });

  it("writes the theme into the localpi state directory", async () => {
    const stateDir = await makeTemporaryDir("localpi-theme-");

    const themePath = await writeLocalpiTheme(stateDir, ["--model", "gemma"]);

    expect(themePath).toBe(localpiThemePath(stateDir));
    const written = JSON.parse(await readFile(themePath ?? "", "utf8")) as {
      readonly name?: string;
      readonly colors?: Record<string, string>;
    };
    expect(written.name).toBe(localpiThemeName);
    expect(written.colors?.["accent"]).toBe("lavender");
  });

  it("does not write a theme when Pi theme loading is disabled", async () => {
    const stateDir = await makeTemporaryDir("localpi-theme-");

    await expect(writeLocalpiTheme(stateDir, ["--no-themes"])).resolves.toBeUndefined();
    await expect(readFile(localpiThemePath(stateDir), "utf8")).rejects.toThrow();
  });

  it("selects Catppuccin unless the user selected another theme", () => {
    const themePath = "/tmp/localpi/pi-themes/catppuccin-mocha.json";

    expect(localpiThemeArgs(undefined, [])).toEqual([]);
    expect(localpiThemeArgs(themePath, ["-p", "say ok"])).toEqual([
      "--theme",
      themePath,
      "--use-theme",
      localpiThemeName
    ]);
    expect(localpiThemeArgs(themePath, ["--use-theme", "light"])).toEqual(["--theme", themePath]);
    expect(localpiThemeArgs(themePath, ["--use-theme=light"])).toEqual(["--theme", themePath]);
  });
  it("builds a Latte theme for web mode from the same palette module", async () => {
    const theme = catppuccinTheme("latte");
    expect(theme.name).toBe(catppuccinThemeName("latte"));
    expect(theme.vars["base"]).toBe(catppuccinLatte.base);
    expect(theme.export.pageBg).toBe(catppuccinLatte.crust);
    expect(theme.colors["toolSuccessBg"]).not.toBe(catppuccinTheme().colors["toolSuccessBg"]);
    const stateDir = await makeTemporaryDir("localpi-theme-latte-");
    const themePath = await writeLocalpiTheme(stateDir, [], "latte");
    expect(themePath).toBe(localpiThemePath(stateDir, "latte"));
    expect(JSON.parse(await readFile(themePath ?? "", "utf8"))).toMatchObject({
      name: "catppuccin-latte"
    });
    expect(localpiThemeArgs(themePath, [], "latte")).toEqual([
      "--theme",
      themePath,
      "--use-theme",
      "catppuccin-latte"
    ]);
  });
});
