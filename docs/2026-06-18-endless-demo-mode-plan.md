---
title: Endless Demo Mode Plan
author: Bob <dutifulbob@gmail.com>
date: 2026-06-18
---

# Endless Demo Mode Plan

This plan covers an endless localpi demo mode that runs inside Pi's normal TUI and repeatedly prompts Pi until the user exits the TUI or interrupts it.

## Goal

`localpi --demo` should run a hands-free local model demo without turning localpi into an interactive chat client and without subverting Pi's native TUI.

The demo orchestration is owned by a localpi-generated Pi extension. Rendering, streaming, tok/s display, input handling, slash commands, session state, and lifecycle remain owned by Pi.

## Target Behavior

- `localpi --demo --model <alias|id|path>` starts Pi once with a built-in initial prompt.
- Pi opens in normal TUI mode.
- The demo extension sends the initial prompt after TUI `session_start`.
- After each completed generation, the demo extension sends the followup prompt after `turn_end`.
- The followup prompt defaults to `Continue. Try to write as long as possible.`
- The loop continues until the user exits Pi, `Ctrl-C` is pressed, or Pi stops the session normally.
- Runtime discovery, Pi config generation, extensions, thinking, tools, and approval behavior match normal localpi launches.
- Demo mode requires an explicit non-`auto` model through `--model` or `LOCALPI_MODEL`; it must not auto-select a model.
- Demo mode requires interactive TTY stdin and stdout so Pi opens its normal TUI.
- Demo mode uses one live Pi session so followup prompts keep the first prompt's context.
- Demo mode works with any provider localpi already supports: LM Studio, vLLM, generic OpenAI-compatible providers, and managed `llama-server`.
- Demo mode does not parse terminal output to detect when generation stops; it relies on Pi extension events.

## Default Prompts

Initial prompt:

```text
You are narrating a never-ending sci-fi adventure. Continue in short paragraphs. Whenever the user sends a message, treat it as a live director note and incorporate it immediately. Never end the story.
```

Followup prompt:

```text
Continue. Try to write as long as possible.
```

## CLI Contract

Add these flags:

- `--demo`: enable endless demo mode.
- `--demo-initial-prompt <text>`: override the first prompt.
- `--demo-followup-prompt <text>`: override every prompt after the first.
- `--demo-initial-prompt-file <path>`: read the first prompt from a UTF-8 file.
- `--demo-followup-prompt-file <path>`: read the followup prompt from a UTF-8 file.

Add matching environment variables:

- `LOCALPI_DEMO`
- `LOCALPI_DEMO_INITIAL_PROMPT`
- `LOCALPI_DEMO_FOLLOWUP_PROMPT`
- `LOCALPI_DEMO_INITIAL_PROMPT_FILE`
- `LOCALPI_DEMO_FOLLOWUP_PROMPT_FILE`

File flags should win over text flags for the same prompt because they are the better interface for long prompts.

Explicit CLI flags should win over environment variables.

## Incompatible Modes

Reject these combinations with clear errors:

- `--demo --status`
- `--demo --stop`
- `--demo --list`
- `--demo` without an explicit non-`auto` model
- `--demo` without interactive TTY stdin and stdout
- `--demo` with user-supplied forwarded Pi prompt flags such as `-p` or `--prompt`

Forwarded non-prompt Pi options should remain allowed.

## Launch Design

Keep `src/pi/launch.ts` as the single-launch layer. Demo mode should use the same launch path as a normal interactive localpi session.

Demo mode should not:

- pass prompts through stdin
- pass prompts with `-p` or `--prompt`
- force print, JSON, or RPC mode
- launch repeated one-shot Pi child processes
- create or manage a parallel localpi TUI

Normal localpi launch planning should write an additional generated extension when `--demo` is enabled, then launch Pi normally.

## Demo Extension

Add a generated Pi extension, likely `demo-mode.ts`, alongside the existing localpi extensions.

The extension owns:

- resolving already-materialized prompt text provided by localpi
- sending the initial prompt once on `session_start` when `ctx.mode === "tui"`
- sending the followup prompt after each final assistant `turn_end` when demo mode is still active
- relying on Pi's own queueing via `pi.sendUserMessage`
- optional later controls such as `/demo stop`

Example shape:

```ts
pi.on("session_start", (event, ctx) => {
  if (started || event.reason !== "startup" || ctx.mode !== "tui") {
    return;
  }
  started = true;
  pi.sendUserMessage(initialPrompt);
});

pi.on("turn_end", (event, ctx) => {
  if (!started || stopped || ctx.mode !== "tui") {
    return;
  }
  if (event.message.role !== "assistant") {
    return;
  }
  if (event.message.stopReason === "aborted" || event.message.stopReason === "error") {
    stopped = true;
    return;
  }
  if (event.message.stopReason === "toolUse") {
    return;
  }
  pi.sendUserMessage(followupPrompt, { deliverAs: "followUp" });
});
```

Prompt file loading should stay in localpi before extension generation. The generated extension should contain concrete prompt strings so Pi does not need to read localpi-specific files at runtime.

## Signal And Exit Behavior

- Pi owns `Ctrl-C`, exit, and interactive lifecycle behavior.
- If a turn ends with an aborted or error assistant message, the demo extension should stop queueing followup prompts.
- If a turn ends with tool use, the demo extension should wait for the final assistant turn before queueing a followup.
- localpi should not restart Pi after exit.
- If Pi exits non-zero, localpi should return the same exit code as a normal launch.
- No special signal-forwarding loop should be needed beyond normal `execLaunchPlan` behavior.

## Non-Goals

- Do not scrape stdout or terminal output to infer completion.
- Do not run demo mode as a hidden headless print-mode loop.
- Do not repeatedly spawn one-shot Pi processes.
- Do not create a second localpi-owned TUI or prompt loop.
- Do not make provider-specific demo behavior.
- Do not add classifier, benchmark, dataset, or schema workflow concepts.
- Do not keep a hidden background service running after localpi exits.

## Testing Checklist

- [x] Parse `--demo` and all demo prompt flags.
- [x] Parse matching `LOCALPI_DEMO*` environment variables.
- [x] Verify CLI prompt values override environment values.
- [x] Verify prompt files override text prompt values.
- [x] Verify `--demo --status`, `--demo --stop`, and `--demo --list` fail clearly.
- [x] Verify demo mode rejects missing or `auto` model selection.
- [x] Verify demo mode rejects non-TTY stdin/stdout.
- [x] Verify demo mode rejects forwarded Pi prompt flags.
- [x] Unit-test that demo mode writes a generated Pi extension.
- [x] Unit-test that the generated extension sends the initial prompt on TUI `session_start`.
- [x] Unit-test that the generated extension sends followup prompts after `turn_end`.
- [x] Unit-test that the generated extension does not queue followups after tool-use continuation turns.
- [x] Unit-test that demo mode uses the normal Pi launch path and does not pipe prompts over stdin.
- [x] Unit-test that normal launches are unchanged.
- [x] Use a fake `LOCALPI_PI_CMD` to prove demo launches Pi once with the demo extension path.
- [x] Verify demo mode does not pass `-p`, `--prompt`, `--mode print`, `--mode json`, or `--mode rpc`.
- [x] Run `npm run check`.

## Documentation Checklist

- [x] Document `--demo` in README options.
- [x] Document prompt override flags.
- [x] Document `LOCALPI_DEMO*` environment variables.
- [x] Include one simple example:

```bash
localpi --demo --model gemma-e4b
```

- [x] Include one override example:

```bash
localpi --demo --model gemma-e4b --demo-initial-prompt-file ./prompts/story.txt --demo-followup-prompt "Continue. Try to write as long as possible."
```
