---
title: Startup Model And Thinking Control Plan
author: Bob <dutifulbob@gmail.com>
date: 2026-06-16
---

# Startup Model And Thinking Control Plan

This plan covers the localpi UX for choosing models and controlling thinking without turning localpi into a second interactive app.

## Goal

Plain `localpi` should make model choice easy when multiple local models are available, while thinking stays controlled by Pi after startup.

Startup selection is for models only. There is no startup thinking picker.

## Target Behavior

- `localpi` discovers all usable local providers before Pi starts.
- If exactly one usable model is available, localpi starts Pi with that model.
- If multiple usable models are available in an interactive terminal, localpi launches Pi with a bootstrap model and Pi opens its native model selector at startup.
- If no external model is available, localpi may fall back to a managed `llama-server` model.
- A concrete `--model` value bypasses the startup model picker. `--provider` alone only scopes the catalog.
- Explicit `--runtime` values scope discovery but do not disable the startup selector by themselves.
- Non-interactive runs never show a picker.
- Pi receives the launch-time model catalog so `/model` can switch across discovered providers and models.
- Thinking starts from `--thinking`, `LOCALPI_THINKING`, the last saved Pi thinking level, or `medium`.
- In-session thinking changes happen through `/thinking` inside Pi.

## Provider Coverage

The startup model catalog should generalize across all local providers that localpi knows how to describe:

- LM Studio: externally managed OpenAI-compatible provider.
- vLLM: externally managed OpenAI-compatible provider.
- Generic OpenAI-compatible providers from localpi config.
- Managed `llama-server`: localpi-owned, startable GGUF aliases and the currently served model.

Localpi should not start or stop externally managed providers. It should only manage localpi-owned `llama-server` processes.

## Startup Model Selection

Selection happens after provider discovery and before Pi config generation.

Interactive behavior:

- If no explicit model was requested and more than one usable model exists, select a deterministic bootstrap model only so Pi can start.
- In the same launch, generate a startup extension that opens Pi's native `ModelSelectorComponent`.
- Label options with provider and model, for example `LM Studio / qwen3.6-35b-a3b-mtp`.
- Prefer a stable ordering so repeated launches are predictable.
- Let Enter choose the first ranked model.

Non-interactive behavior:

- Do not prompt.
- Use a deterministic default when one exists.
- If multiple loaded models match, use the first deterministic bootstrap model and let automation pin another model with `--provider` and `--model` when needed.

Explicit selection behavior:

- `--provider <id> --model <id>` selects an exact catalog entry.
- `--provider <id>` without `--model` scopes startup discovery and still opens the Pi-native picker when multiple loaded models match.
- `--runtime lmstudio` and `--runtime vllm` select the built-in external provider.
- Managed `llama-server` aliases continue to work through `--model <alias>`.

## Pi Model Switching

Localpi should pass the full launch-time catalog to Pi instead of creating a localpi-only `/model` extension.

Generated Pi config should include:

- one provider entry per discovered provider
- every discovered usable model under its provider
- selected provider and selected model in `settings.json`
- context window and max token metadata when known
- reasoning metadata when known
- provider compatibility metadata when needed, such as Qwen or DeepSeek thinking format

Pi owns the `/model` command and the native startup model selector UI. Localpi's job is to give Pi a complete model catalog at launch and request that native selector when startup model choice is needed.

Live model refresh after Pi starts is out of scope for this plan. That should be a future Pi/provider integration.

## Thinking Control

Thinking is not selected at startup through a picker.

Startup defaults:

- `localpi` starts with the last saved thinking level, or `medium` if none is saved.
- `LOCALPI_THINKING=<level>` overrides the saved startup default.
- `localpi --thinking <level>` overrides the saved startup default.
- The chosen startup value is passed to Pi as `--thinking <level>` and written to `settings.json.defaultThinkingLevel`.

In-session control:

- Pi provides the `/thinking` command. Pi owns runtime mutation of the thinking level.
- The localpi extension saves the actual Pi thinking level to localpi state for the next launch.

Superseded: localpi first registered its own `/thinking` extension command. Pi already owns that
name, so Pi skipped the localpi command in autocomplete. Localpi now keeps only the persistence
hooks (`thinking_level_select` and `session_shutdown`) and leaves the command to Pi.

Managed `llama-server` thinking budget:

A reasoning model can loop in its thinking and never answer. The managed server bounds that by
cutting the thinking at a token budget and forcing the end-of-thinking tag, so the turn still
produces an answer.

- Server-side reasoning budget is still chosen at startup. Changing it later restarts the
  localpi-owned server process.
- Thinking levels map to token budgets: `off` passes `--reasoning off` and no budget, `minimal` 32,
  `low` 128, `medium` 512, `high` 2048, and `xhigh` 16384.
- `--thinking-budget <n>` and `LOCALPI_THINKING_BUDGET` set the budget directly. `-1` means
  unrestricted, and a positive value replaces the budget of the level table. Any other value fails
  with a clear message.
- When the budget is finite, localpi passes a default message that the server injects before the
  end-of-thinking tag, so the model knows why the thinking stopped. `--thinking-budget-message
<text>` and `LOCALPI_THINKING_BUDGET_MESSAGE` reword that default, and an empty value passes no
  message flag at all.
- The message override is optional text with no validation, so the default still has its escape
  hatch and a model that needs different wording can get it.
- The engine detects the thinking tags from the model template. Localpi does not hardcode a tag, and
  it does not pass reasoning effort levels that the template rejects.
- The managed server metadata records the reasoning mode, the budget, and the message. A changed
  value restarts the owned server, as the budget check already does.
- The reasoning translation stays in the `llama-server` adapter. There is no engine-agnostic
  reasoning layer, because localpi starts only the managed `llama-server`; LM Studio and vLLM are
  external servers that localpi only connects to.

## Implementation Checklist

- [x] Discover a normalized launch-time model catalog across providers.
- [x] Add startup model selection when multiple models are available interactively.
- [x] Use Pi's native model selector UI at startup instead of a localpi-owned terminal prompt.
- [x] Pass the launch-time catalog into generated Pi model config.
- [x] Keep `/model` owned by Pi.
- [x] Add reasoning and thinking-format metadata for known local reasoning models.
- [x] Add `/thinking` as a Pi extension command. Superseded: Pi owns the name, so the extension now only remembers the level.
- [x] Keep startup thinking non-interactive.
- [x] Keep `--thinking` and `LOCALPI_THINKING` as automation-safe startup controls.
- [x] Remember the last Pi thinking level for future localpi launches.
- [x] Add `--thinking-budget` and `LOCALPI_THINKING_BUDGET` for the managed `llama-server`.
- [x] Inject a default message before the end-of-thinking tag when the budget is finite.
- [x] Add `--thinking-budget-message` and `LOCALPI_THINKING_BUDGET_MESSAGE` to reword the message, or to pass none.
- [x] Record the reasoning mode, the budget, and the message in the managed server metadata.
- [x] Test the level table, the budget override, an invalid value, and the restart trigger.
- [ ] Manually verify model picker behavior in an interactive terminal with multiple loaded providers.
- [ ] Manually verify Pi `/model` can switch among generated catalog entries.
- [ ] Manually verify Pi `/thinking` picker and direct `/thinking <level>` command.

## Out Of Scope

- A startup thinking selector.
- A localpi-owned `/model` extension.
- Live refresh of models after Pi starts.
- Starting or stopping LM Studio, vLLM, or other externally managed providers.
- Guessing random provider ports.
- Cloud provider authentication.
- Caller-specific workflows such as classifier routing or schema-constrained output.
