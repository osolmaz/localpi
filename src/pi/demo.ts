import { readFile } from "node:fs/promises";

import type { LocalpiOptions } from "../localpi/options.js";

export const defaultDemoInitialPrompt =
  "You are narrating a never-ending sci-fi adventure. Continue in short paragraphs. Whenever the user sends a message, treat it as a live director note and incorporate it immediately. Never end the story.";

export const defaultDemoFollowupPrompt = "Continue. Try to write as long as possible.";

export type DemoPrompts = {
  readonly initial: string;
  readonly followup: string;
};

export async function resolveDemoPrompts(options: LocalpiOptions): Promise<DemoPrompts> {
  return {
    initial: await resolvePrompt(
      options.demoInitialPrompt,
      options.demoInitialPromptFile,
      defaultDemoInitialPrompt
    ),
    followup: await resolvePrompt(
      options.demoFollowupPrompt,
      options.demoFollowupPromptFile,
      defaultDemoFollowupPrompt
    )
  };
}

async function resolvePrompt(
  text: string | undefined,
  file: string | undefined,
  fallback: string
): Promise<string> {
  return file === undefined ? (text ?? fallback) : await readFile(file, "utf8");
}
