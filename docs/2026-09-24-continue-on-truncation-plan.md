---
date: 2026-09-24
author: Onur Solmaz
title: Continue on truncation for localpi
tags:
  - localpi
  - pi
  - plan
---

# Continue on truncation for localpi

## Status

Planned. This document is the selected plan for the feature. It is the only source to follow.

## Goal

Give localpi an opt-in way to continue a Pi turn that stopped because it hit the output token limit.

A truncated final reply is worthless in a batch run: the model stops mid-answer, the harness ends the
run, and a verifier scores the half-written result as zero. Measured on the ShellBench Structured
suite, this happened in 16 of 89 tasks with one model and 6 of 89 with another.

The feature is off by default. A normal launch must behave exactly as it does today.

## Design

Today localpi declares the served limits itself: `--context-window` and `--max-tokens` (default
8192). Pi stops a turn when the reply reaches the declared output cap and reports the turn as
complete. localpi does nothing about it, so the reply stays truncated.

Design rules:

- Opt-in only. No flag and no environment variable means the current behavior, byte for byte.
- Flag, then environment, then default, like every other localpi option.
- Every default needs a flag or an environment variable, per `docs/design-principles.md`.
- The guard is a Pi extension that uses only the documented public Pi extension API.
- One implementation. The harness repository must not carry a second copy afterward.

### Interface

| Interface                            | Meaning                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `--continue-on-truncation <n>`       | Continue at most `n` extra times when a turn ends on the output token limit. |
| `LOCALPI_CONTINUE_ON_TRUNCATION=<n>` | Same meaning from the environment.                                           |
| absent                               | Feature off.                                                                 |

`n` must be a positive integer. `0` means off and is allowed only from the environment, so an
operator can disable an inherited value without dropping the variable. An invalid `n` fails with one
clear message and exit code 2, like the other option errors.

### Behavior

- Detect the truncation stop reason on the turn-end hook. Pi reports a turn that reached the output
  cap as a length stop, so no guessing is needed.
- Send exactly one follow-up user message that tells the model to continue where it stopped and not
  to repeat earlier text.
- Count continuations per session. Stop after `n` and let the run end normally, so the feature cannot
  loop forever.
- Never continue a turn that ended for any other reason, including a normal stop, a tool-only turn,
  an error stop, or a user cancellation.
- Write warnings and notes to stderr only. stdout stays free for protocol bytes and batch output.
- The generated extension carries the limit inside its own source, like the other generated extension
  sources, so no extra environment variable reaches the child.

### Where the code goes

- `src/pi/extension-sources/continue-on-truncation.ts`: the generated Pi extension source, plus the
  factory that bakes the limit into it.
- `src/pi/extensions.ts`: add the extension to the bundle only when the feature is enabled.
- `src/localpi/options.ts`: the `continueOnTruncation` option, its flag, its environment variable, the
  usage line, and its validation.
- `src/cli/cli.ts`: pass the resolved value into the extension bundle.

The extension source follows the existing pattern of the other `extension-sources` modules. The
optional feature stays out of the runtime resolution path, so discovery, Pi config generation, and
process launching keep their current separation.

## Deliverables

1. The new extension source module and its wiring.
2. The option, the flag, the environment variable, the usage line, and validation.
3. Tests: option parsing and validation, the extension bundle containing the guard only when it is
   enabled, a truncated turn producing exactly one continuation message, the continuation count
   stopping at `n`, and a non-truncated turn producing no continuation.
4. A README section for the feature.
5. An entry in `docs/runtime-specification.md` and a section in `docs/implementation-plan.md`.

## Acceptance

- `npm run check` passes, including `prettier --check`, `eslint`, `tsc --noEmit`, the full test
  suite, and the build.
- The tests prove the off-by-default behavior is unchanged, the enabled behavior continues at most
  `n` times, and a non-truncated turn is untouched.
- The coverage thresholds stay satisfied.
- No generated output, model response, session file, or secret is committed.

## Out of scope

- Publishing to npm and creating a release.
- Any change to the harness repository, including its existing guard and its published artifacts.
- Any change to the thinking budget, the model profile limits, or the ACP mode contract.
- Any change to a normal launch when the feature is off.

## Constraints

- Follow `AGENTS.md`: strict TypeScript, no `any`, validate unknown JSON at the boundary.
- Keep local model discovery, Pi config generation, and process launching in separate modules.
- Add or update tests for every behavior change.
- Keep mutation testing out of the default gate.
- Keep `@earendil-works/pi-coding-agent` a devDependency on the newest Pi release and keep the
  generated-extension typecheck test.
- Keep `@osolmaz/pi-factory` on the newest published version.
- Use Conventional Commits, and add no coding agent branding.
