// Catppuccin palettes. Source: https://catppuccin.com/palette (MIT).
//
// Mocha has two consumers: the Pi theme localpi writes for each terminal session, and localpi's own
// terminal output. Keep both on this palette so the launcher and the session match. Web mode uses
// one flavor for the page and the Pi theme, Latte by default.
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

export const catppuccinFrappe: Readonly<Record<CatppuccinColor, string>> = {
  rosewater: "#f2d5cf",
  flamingo: "#eebebe",
  pink: "#f4b8e4",
  mauve: "#ca9ee6",
  red: "#e78284",
  maroon: "#ea999c",
  peach: "#ef9f76",
  yellow: "#e5c890",
  green: "#a6d189",
  teal: "#81c8be",
  sky: "#99d1db",
  sapphire: "#85c1dc",
  blue: "#8caaee",
  lavender: "#babbf1",
  text: "#c6d0f5",
  subtext1: "#b5bfe2",
  subtext0: "#a5adce",
  overlay2: "#949cbb",
  overlay1: "#838ba7",
  overlay0: "#737994",
  surface2: "#626880",
  surface1: "#51576d",
  surface0: "#414559",
  base: "#303446",
  mantle: "#292c3c",
  crust: "#232634"
};

export const catppuccinMacchiato: Readonly<Record<CatppuccinColor, string>> = {
  rosewater: "#f4dbd6",
  flamingo: "#f0c6c6",
  pink: "#f5bde6",
  mauve: "#c6a0f6",
  red: "#ed8796",
  maroon: "#ee99a0",
  peach: "#f5a97f",
  yellow: "#eed49f",
  green: "#a6da95",
  teal: "#8bd5ca",
  sky: "#91d7e3",
  sapphire: "#7dc4e4",
  blue: "#8aadf4",
  lavender: "#b7bdf8",
  text: "#cad3f5",
  subtext1: "#b8c0e0",
  subtext0: "#a5adcb",
  overlay2: "#939ab7",
  overlay1: "#8087a2",
  overlay0: "#6e738d",
  surface2: "#5b6078",
  surface1: "#494d64",
  surface0: "#363a4f",
  base: "#24273a",
  mantle: "#1e2030",
  crust: "#181926"
};

export type CatppuccinFlavor = "latte" | "frappe" | "macchiato" | "mocha";

export const catppuccinFlavors: readonly CatppuccinFlavor[] = [
  "latte",
  "frappe",
  "macchiato",
  "mocha"
];

export const catppuccinPalettes: Readonly<
  Record<CatppuccinFlavor, Readonly<Record<CatppuccinColor, string>>>
> = {
  latte: catppuccinLatte,
  frappe: catppuccinFrappe,
  macchiato: catppuccinMacchiato,
  mocha: catppuccinMocha
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
