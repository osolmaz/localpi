import { describe, expect, it } from "vitest";

import type { PiAppDefinition } from "@osolmaz/pi-factory";
import type { PiWebOptions } from "@osolmaz/pi-factory-web";

import { run } from "../src/cli/cli.js";
import { catppuccinLatte } from "../src/localpi/catppuccin.js";
import { launchWebRuntime, localpiWebTheme } from "../src/pi/web.js";

describe("localpi web mode", () => {
  it("rejects modes that cannot share the browser terminal", async () => {
    const acp = await run(["--web", "--acp", "--model", "served-model"]);
    expect(acp.code).toBe(2);
    expect(acp.stderr).toContain("--web cannot be used with --acp");

    const demo = await run(["--web", "--demo", "--model", "served-model"]);
    expect(demo.code).toBe(2);
    expect(demo.stderr).toContain("--web cannot be used with --demo");

    const mode = await run(["--web", "--mode", "json"]);
    expect(mode.code).toBe(2);
    expect(mode.stderr).toContain("--web cannot be used with forwarded Pi mode json");

    const print = await run(["--web", "-p", "hello"]);
    expect(print.code).toBe(2);
    expect(print.stderr).toContain("--web cannot be used with forwarded Pi flag -p");
  });

  it("lets an immediate command win over web mode", async () => {
    const list = await run(["--web", "--mode", "json", "--list"]);
    expect(list.code).toBe(0);
    expect(list.stderr).not.toContain("--web cannot");
  });

  it("serves the app with the web options and the Latte theme", async () => {
    const calls: { app: PiAppDefinition; options: PiWebOptions }[] = [];
    const app = { id: "localpi" } as PiAppDefinition;

    const code = await launchWebRuntime(
      app,
      { webPort: 8421, webOpen: false, webHost: "100.64.0.1", webAllowedHosts: ["box"] },
      (served, options = {}) => {
        calls.push({ app: served, options });
        return Promise.resolve(0);
      }
    );

    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        app,
        options: {
          host: "100.64.0.1",
          allowedHosts: ["box"],
          port: 8421,
          open: false,
          cwd: process.cwd(),
          theme: localpiWebTheme()
        }
      }
    ]);
  });

  it("builds the page colors from the Latte palette", () => {
    const theme = localpiWebTheme();
    expect(theme.background).toBe(catppuccinLatte.base);
    expect(theme.foreground).toBe(catppuccinLatte.text);
    expect(theme.accent).toBe(catppuccinLatte.mauve);
    expect(theme.black).toBe(catppuccinLatte.subtext1);
  });
});
