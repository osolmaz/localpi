// Generated Pi extensions are standalone files, so they cannot import from each other. Both the
// stats extension and the approval extension read and write the localpi settings file, so they
// embed this one snippet instead of keeping two copies of the same code.
//
// The embedding extension must import `mkdir`, `readFile`, and `writeFile` from `node:fs/promises`
// and `dirname` from `node:path`.
export function settingsFileSource(settingsPath: string): string {
  const settingsPathSource = JSON.stringify(settingsPath);
  return `const settingsPath = ${settingsPathSource};

async function readSettings(): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    return settingsRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

async function writeSettings(settings: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

function settingsRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
`;
}
