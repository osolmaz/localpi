// Catppuccin palettes. Source: https://catppuccin.com/palette (MIT).
//
// Mocha has two consumers: the Pi theme localpi writes for each terminal session, and localpi's own
// terminal output. Keep both on this palette so the launcher and the session match. Latte is the
// light flavor for web mode, where the page and the Pi theme share it.
export const catppuccinMocha = {
  rosewater: "#f5e0dc",
  flamingo: "#f2cdcd",
  pink: "#f5c2e7",
  mauve: "#cba6f7",
  red: "#f38ba8",
  maroon: "#eba0ac",
  peach: "#fab387",
  yellow: "#f9e2af",
  green: "#a6e3a1",
  teal: "#94e2d5",
  sky: "#89dceb",
  sapphire: "#74c7ec",
  blue: "#89b4fa",
  lavender: "#b4befe",
  text: "#cdd6f4",
  subtext1: "#bac2de",
  subtext0: "#a6adc8",
  overlay2: "#9399b2",
  overlay1: "#7f849c",
  overlay0: "#6c7086",
  surface2: "#585b70",
  surface1: "#45475a",
  surface0: "#313244",
  base: "#1e1e2e",
  mantle: "#181825",
  crust: "#11111b"
} as const;

export type CatppuccinColor = keyof typeof catppuccinMocha;

export const catppuccinLatte: Readonly<Record<CatppuccinColor, string>> = {
  rosewater: "#dc8a78",
  flamingo: "#dd7878",
  pink: "#ea76cb",
  mauve: "#8839ef",
  red: "#d20f39",
  maroon: "#e64553",
  peach: "#fe640b",
  yellow: "#df8e1d",
  green: "#40a02b",
  teal: "#179299",
  sky: "#04a5e5",
  sapphire: "#209fb5",
  blue: "#1e66f5",
  lavender: "#7287fd",
  text: "#4c4f69",
  subtext1: "#5c5f77",
  subtext0: "#6c6f85",
  overlay2: "#7c7f93",
  overlay1: "#8c8fa1",
  overlay0: "#9ca0b0",
  surface2: "#acb0be",
  surface1: "#bcc0cc",
  surface0: "#ccd0da",
  base: "#eff1f5",
  mantle: "#e6e9ef",
  crust: "#dce0e8"
};

export type CatppuccinFlavor = "mocha" | "latte";

export const catppuccinPalettes: Readonly<
  Record<CatppuccinFlavor, Readonly<Record<CatppuccinColor, string>>>
> = {
  mocha: catppuccinMocha,
  latte: catppuccinLatte
};

export type OutputStream = "stdout" | "stderr";

const ansiReset = "\u001B[0m";

export function colorsEnabled(stream: OutputStream = "stdout"): boolean {
  if (forcedColor()) {
    return true;
  }
  if (noColor()) {
    return false;
  }
  const target = stream === "stderr" ? process.stderr : process.stdout;
  // Node types mark isTTY as a boolean, but a pipe leaves it undefined at runtime.
  return Boolean(target.isTTY as boolean | undefined);
}

export function paint(
  text: string,
  color: CatppuccinColor,
  stream: OutputStream = "stdout"
): string {
  if (text === "" || !colorsEnabled(stream)) {
    return text;
  }
  return `${trueColor(catppuccinMocha[color])}${text}${ansiReset}`;
}

function forcedColor(): boolean {
  const value = process.env["FORCE_COLOR"];
  return value !== undefined && value !== "" && value !== "0";
}

function noColor(): boolean {
  const value = process.env["NO_COLOR"];
  return (value !== undefined && value !== "") || process.env["TERM"] === "dumb";
}

function trueColor(hex: string): string {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `\u001B[38;2;${String(red)};${String(green)};${String(blue)}m`;
}
