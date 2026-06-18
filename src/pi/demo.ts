import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { LocalpiOptions } from "../localpi/options.js";
import type { RuntimeConnection } from "../localpi/runtime.js";
import type { RuntimeConfig } from "./config.js";
import type { ExtensionBundle } from "./extensions.js";
import { createLaunchPlan, execLaunchPlan, terminateLaunchProcess } from "./launch.js";

export const defaultDemoInitialPrompt =
  "You are narrating a never-ending sci-fi adventure. Continue in short paragraphs. Whenever the user sends a message, treat it as a live director note and incorporate it immediately. Never end the story.";

export const defaultDemoFollowupPrompt = "Continue.";

export type DemoPrompts = {
  readonly initial: string;
  readonly followup: string;
};

type InterruptState = {
  interrupted: boolean;
  exitCode: number;
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

export async function execDemoLoop(
  options: LocalpiOptions,
  runtimeConfig: RuntimeConfig,
  connection: RuntimeConnection,
  extensions: ExtensionBundle
): Promise<number> {
  const prompts = await resolveDemoPrompts(options);
  const sessionId = demoSessionId();
  const interrupt = interruptState();
  let activeChild: ChildProcess | undefined;
  const signalHandler = (signal: NodeJS.Signals): void => {
    interrupt.interrupted = true;
    interrupt.exitCode = signalExitCode(signal);
    if (activeChild !== undefined) {
      terminateLaunchProcess(activeChild, signal);
    }
  };
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);
  try {
    for (let iteration = 0; !interrupt.interrupted; iteration += 1) {
      const prompt = iteration === 0 ? prompts.initial : prompts.followup;
      const plan = await createLaunchPlan(options, runtimeConfig, connection, extensions, {
        forwardedArgs: demoForwardedArgs(options.forwardedArgs, sessionId, prompt)
      });
      const code = await execLaunchPlan(plan, {
        detached: true,
        forwardSignals: false,
        onChild: (child) => {
          activeChild = child;
        }
      });
      activeChild = undefined;
      if (code !== 0) {
        return code;
      }
    }
    return interrupt.exitCode;
  } finally {
    process.removeListener("SIGINT", signalHandler);
    process.removeListener("SIGTERM", signalHandler);
  }
}

function demoForwardedArgs(
  forwardedArgs: readonly string[],
  sessionId: string,
  prompt: string
): readonly string[] {
  return ["--session-id", sessionId, ...forwardedArgs, "-p", prompt];
}

function demoSessionId(): string {
  return `localpi-demo-${randomUUID()}`;
}

async function resolvePrompt(
  text: string | undefined,
  file: string | undefined,
  fallback: string
): Promise<string> {
  return file === undefined ? (text ?? fallback) : await readFile(file, "utf8");
}

function interruptState(): InterruptState {
  return { interrupted: false, exitCode: 0 };
}

function signalExitCode(signal: NodeJS.Signals): number {
  switch (signal) {
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    default:
      return 1;
  }
}
