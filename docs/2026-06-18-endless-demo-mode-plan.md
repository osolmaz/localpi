---
title: Endless Demo Mode Plan
author: Bob <dutifulbob@gmail.com>
date: 2026-06-18
---

# Endless Demo Mode Plan

This plan covers an endless localpi demo mode that repeatedly prompts Pi until the user exits localpi or interrupts it.

## Goal

`localpi --demo` should run a hands-free local model demo without turning localpi into an interactive chat client or depending on Pi terminal internals.

The demo loop is owned by localpi. Each individual generation is still owned by Pi.

## Target Behavior

- `localpi --demo` starts Pi once with a built-in initial prompt.
- After Pi completes that prompt and exits successfully, localpi starts Pi again with the followup prompt.
- The followup prompt defaults to `Continue.`
- The loop continues until localpi is exited, `Ctrl-C` is pressed, or Pi exits with a non-zero status.
- Runtime discovery, model selection, Pi config generation, extensions, thinking, tools, and approval behavior match normal localpi launches.
- Each demo run uses one generated Pi session id so followup prompts keep the first prompt's context.
- Demo mode works with any provider localpi already supports: LM Studio, vLLM, generic OpenAI-compatible providers, and managed `llama-server`.
- Demo mode does not parse terminal output to detect when generation stops.

## Default Prompts

Initial prompt:

```text
You are narrating a never-ending sci-fi adventure. Continue in short paragraphs. Whenever the user sends a message, treat it as a live director note and incorporate it immediately. Never end the story.
```

Followup prompt:

```text
Continue.
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
- `--demo` with user-supplied forwarded Pi prompt flags such as `-p` or `--prompt`

Forwarded non-prompt Pi options should remain allowed.

## Launch Design

Keep `src/pi/launch.ts` as the single-launch layer.

Refactor `createLaunchPlan` so callers can provide a forwarded-argument override or extra prompt arguments without mutating `LocalpiOptions.forwardedArgs`.

Example shape:

```ts
createLaunchPlan(options, runtimeConfig, connection, extensions, {
  forwardedArgs: ["-p", prompt]
});
```

Normal mode should keep using `options.forwardedArgs`.

Demo mode should call the same launch planner with `["-p", prompt]` for each iteration.

## Demo Runner

Add a focused module, likely `src/pi/demo.ts`, that owns:

- resolving default, environment, CLI, and file prompts
- selecting the initial prompt for iteration 1
- selecting the followup prompt for iteration 2 and later
- calling `createLaunchPlan` and `execLaunchPlan`
- forwarding or honoring `SIGINT` and `SIGTERM`
- stopping the loop on non-zero Pi exit

The runner should not duplicate runtime resolution or config generation. `src/cli/cli.ts` should still resolve runtime and write Pi config before choosing normal launch versus demo loop.

## Signal And Exit Behavior

- If Pi exits `0`, continue to the next prompt.
- If Pi exits non-zero, stop the loop and return that exit code.
- If the user presses `Ctrl-C`, terminate the active Pi child and exit localpi cleanly.
- If localpi receives `SIGTERM`, terminate the active Pi child and exit cleanly.
- Do not restart after an interrupt.

If `execLaunchPlan` currently hides too much child-process control, split out a child runner that can be reused by both normal mode and demo mode.

## Non-Goals

- Do not scrape stdout or terminal output to infer completion.
- Do not add a Pi extension for demo looping.
- Do not require Pi internals or a Pi event API.
- Do not make provider-specific demo behavior.
- Do not add classifier, benchmark, dataset, or schema workflow concepts.
- Do not keep a hidden background service running after localpi exits.

## Testing Checklist

- [x] Parse `--demo` and all demo prompt flags.
- [x] Parse matching `LOCALPI_DEMO*` environment variables.
- [x] Verify CLI prompt values override environment values.
- [x] Verify prompt files override text prompt values.
- [x] Verify `--demo --status`, `--demo --stop`, and `--demo --list` fail clearly.
- [x] Verify demo mode rejects forwarded Pi prompt flags.
- [x] Unit-test launch planning so demo prompts are passed as `-p <prompt>`.
- [x] Unit-test that normal launches are unchanged.
- [x] Use a fake `LOCALPI_PI_CMD` that exits `0` and records args to prove first prompt then followup prompts are sent in order.
- [x] Use a fake `LOCALPI_PI_CMD` that exits non-zero to prove the loop stops and returns the child exit code.
- [x] Verify each demo iteration uses the same generated Pi session id.
- [ ] Add an interrupt-oriented test if the process runner is made injectable enough to do that without flaking.
- [x] Run `npm run check`.

## Documentation Checklist

- [x] Document `--demo` in README options.
- [x] Document prompt override flags.
- [x] Document `LOCALPI_DEMO*` environment variables.
- [x] Include one simple example:

```bash
localpi --demo
```

- [x] Include one override example:

```bash
localpi --demo --demo-initial-prompt-file ./prompts/story.txt --demo-followup-prompt "Continue."
```
