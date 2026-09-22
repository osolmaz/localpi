import { afterEach, describe, expect, it } from "vitest";

import { catppuccinMocha, colorsEnabled, paint } from "../src/common/catppuccin.js";

const previous = {
  noColor: process.env["NO_COLOR"],
  forceColor: process.env["FORCE_COLOR"],
  term: process.env["TERM"],
  stdoutIsTty: process.stdout.isTTY,
  stderrIsTty: process.stderr.isTTY
};

afterEach(() => {
  restoreEnv("NO_COLOR", previous.noColor);
  restoreEnv("FORCE_COLOR", previous.forceColor);
  restoreEnv("TERM", previous.term);
  setTty(process.stdout, previous.stdoutIsTty);
  setTty(process.stderr, previous.stderrIsTty);
});

describe("Catppuccin terminal colors", () => {
  it("paints Mocha truecolor output for a terminal", () => {
    clearColorEnv();
    setTty(process.stdout, true);

    expect(colorsEnabled("stdout")).toBe(true);
    expect(paint("runtime:", "overlay1")).toBe("\u001B[38;2;127;132;156mruntime:\u001B[0m");
    expect(paint("warning:", "peach")).toBe("\u001B[38;2;250;179;135mwarning:\u001B[0m");
  });

  it("keeps output plain for pipes", () => {
    clearColorEnv();
    setTty(process.stdout, undefined);

    expect(colorsEnabled("stdout")).toBe(false);
    expect(paint("runtime:", "overlay1")).toBe("runtime:");
  });

  it("keeps output plain when NO_COLOR is set", () => {
    clearColorEnv();
    setTty(process.stdout, true);
    process.env["NO_COLOR"] = "1";

    expect(colorsEnabled("stdout")).toBe(false);
    expect(paint("runtime:", "overlay1")).toBe("runtime:");
  });

  it("keeps output plain when TERM is dumb", () => {
    clearColorEnv();
    setTty(process.stdout, true);
    process.env["TERM"] = "dumb";

    expect(colorsEnabled("stdout")).toBe(false);
  });

  it("forces color with FORCE_COLOR and reads the stream separately", () => {
    clearColorEnv();
    setTty(process.stdout, false);
    setTty(process.stderr, true);

    expect(colorsEnabled("stdout")).toBe(false);
    expect(colorsEnabled("stderr")).toBe(true);
    expect(paint("localpi:", "red")).toBe("localpi:");

    process.env["FORCE_COLOR"] = "1";
    expect(paint("localpi:", "red")).toBe("\u001B[38;2;243;139;168mlocalpi:\u001B[0m");
  });

  it("keeps empty text unchanged", () => {
    clearColorEnv();
    setTty(process.stdout, true);

    expect(paint("", "red")).toBe("");
  });

  it("uses the Catppuccin Mocha palette", () => {
    expect(catppuccinMocha.base).toBe("#1e1e2e");
    expect(catppuccinMocha.mantle).toBe("#181825");
    expect(catppuccinMocha.crust).toBe("#11111b");
    expect(catppuccinMocha.text).toBe("#cdd6f4");
    expect(catppuccinMocha.mauve).toBe("#cba6f7");
    expect(catppuccinMocha.lavender).toBe("#b4befe");
  });
});

function clearColorEnv(): void {
  restoreEnv("NO_COLOR", undefined);
  restoreEnv("FORCE_COLOR", undefined);
  restoreEnv("TERM", previous.term);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  process.env[name] = value;
}

function setTty(stream: NodeJS.WriteStream, value: boolean | undefined): void {
  Object.defineProperty(stream, "isTTY", {
    configurable: true,
    value
  });
}
