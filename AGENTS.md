# AGENTS.md - localpi

This repository is a TypeScript CLI that runs Pi against local inference engines.

Before finishing code changes, run:

```bash
npm run check
```

Rules:

- Keep TypeScript strict. Do not use `any`; validate unknown JSON at the boundary.
- Keep local model discovery, Pi config generation, and process launching in separate modules.
- Add or update tests for behavior changes.
- Keep classifier-specific and final-schema workflows out of this repo. Those belong in callers such as localpager-agent.
- Follow `docs/design-principles.md`: simple, unopinionated, and customizable. Every default needs a flag or environment variable, and every interactive setting needs an in-session command when that is cheap to add.
- Do not commit generated output, local model responses, secrets, session files, or downloaded model files.
- Store persistent localpi user settings in `<state-dir>/settings.json`. Do not create a new top-level state file for each setting; add a field to the settings object instead. Separate files are only for distinct generated artifacts, runtime metadata, caches, logs, or external config formats.
- Follow the Slophammer agent entrypoint in `osolmaz/slophammer/docs/AGENT_ENTRYPOINT.md` when changing repo structure or quality gates.
- llama.cpp is the default local engine. Keep the `llama-cpp` provider first in `auto` discovery order so a loaded llama.cpp model wins automatic selection, and keep the managed `llama-server` fallback llama.cpp-based. Do not move another engine ahead of llama.cpp.
- Keep `@osolmaz/pi-factory` on the newest published version. When its API changes, adapt localpi instead of pinning an old release.
- Keep `@earendil-works/pi-coding-agent` as a devDependency on the newest Pi release, and keep the generated-extension typecheck test. Pi extension API drift must fail `npm test`, not a launch.
- Keep mutation testing out of the default gate. `npm run check` and the push/PR CI stay fast; `npm run mutate` is a manual, occasional run and the weekly `mutation` workflow.

## Pi Launch

- Keep the default Pi launch command at `npx -y @earendil-works/pi-coding-agent@latest`, so a normal launch runs the newest Pi release. Keep `--pi-command` and `LOCALPI_PI_CMD` as the escape hatches.
- Keep the Pi launch command a program plus arguments. pi-factory spawns it without a shell, so do not pass shell syntax, quoting, or environment prefixes through `--pi-command`.
- Split a typed Pi launch command with `parsePiCommand`, and keep quoted words together so a path with spaces survives.

## llama.cpp

llama.cpp is localpi's default and preferred local engine.

- The `llama-cpp` provider probes `http://127.0.0.1:8080/v1` by default and is listed first in `auto` discovery.
- It reads llama.cpp `/v1/models` entries. A model with `status.value` `loaded`, or with no status at all, is usable. A model with `status.value` `unloaded` is offered as startable only when `/props` reports `models_autoload`.
- External llama.cpp servers are never started, stopped, or unloaded by localpi. Only the localpi-owned managed `llama-server` process is managed.
- Keep llama.cpp-specific parsing in the shared model-discovery layer instead of duplicating it in callers.
- Read image input from the server, never from the model name. A llama.cpp entry that lists `image` in `architecture.input_modalities` makes the Pi model config say `input: ["text", "image"]`; every other model stays `input: ["text"]`. A model profile may state `capabilities.image` for a server that reports nothing, and the profile wins in both directions. A model that takes images needs a multimodal projector on the server (`--mmproj`), and localpi does not start or configure that server.

## Status Display

The status display follows `docs/design-principles.md`: simple, unopinionated, customizable.

- Keep the status line to one row. Localpi replaces Pi's footer through `ctx.ui.setFooter` and renders one line: working directory and branch, token totals and cache, context use, then the engine next to the model. Do not call `setStatus`, which would add another row.
- Show a number in one place at a time. The status line drops the context group and the last rate while the model runs, because the live line shows both then.
- Keep the live rate in the working line and the rate of the last finished turn in the status line while the model is idle, so the speed stays visible after an answer ends. Publish that turn between the two generated extensions through the typed `localpiStats` global. Do not use a second status item for it, because a status item adds a row. Drop the rate first when the line is too narrow.
- Build the engine label from the launch-time provider map (`engineEntries`) and follow the current model's provider. Never guess an engine from a model name or a base URL. When the engine is unknown, show no label.
- Treat absent footer data as absent. Pi can return `null` for the git branch and the session name, and an extension must not crash on it.
- Keep the live line as the only place for live turn numbers (elapsed time, output tokens, token rate, prefill progress, context use). Keep the word `Working` in it, keep the statistics in plain parentheses after it, and keep the order elapsed time, output tokens, rate, then context use.
- Keep the precedence order: `--stats`, `LOCALPI_STATS`, the saved `/stats` value in `<state-dir>/settings.json`, then the default. Keep `--no-token-status` as an alias for `--stats off`.
- Keep the mode order `off`, `line`, `full`, with `full` as the default.
- Keep the live line in Pi's native working row through `ctx.ui.setWorkingMessage`, and keep the word `Working` in that line.
- Keep the status line extension (`status-line.ts`) written whenever the stats display is on, and keep the footer untouched in `off` mode.
- Poll the llama.cpp `/slots` endpoint for prefill progress only for llama.cpp runtimes, and stop polling when the endpoint fails. Never invent a prefill percentage.
- Prefer usage numbers that Pi reports. When only a character-based estimate is available, keep it an estimate and do not label it as measured.

## Tool Approval

Tool approval follows `docs/design-principles.md`: on by default, off on request, never silent.

- Always write the tool approval extension, with `initialEnabled` from `--no-approval`/`LOCALPI_APPROVAL` or from the saved `permission` setting. Never remove the extension to express a disabled gate, because that removes the `/approval` command too.
- Offer three choices in the dialogs: allow once, allow every tool call for this session, and deny and stop the turn. Treat a cancelled dialog as a deny, and treat a missing terminal as a deny.
- Make a deny stop the turn: return `{ block: true, reason, terminate: true }`, so the model does not retry the denied call in the same turn. Pi ends the turn only when every blocked result in the tool batch asks for it, so a batch that also holds an allowed read-only call finishes that call first.
- Keep the dialog choice session-scoped. Only `/approval ask|allow` writes the `permission` setting in `<state-dir>/settings.json`, and only as the launch default for new sessions.
- Keep `/approval` in the gate extension, next to the code that blocks tool calls. Keep the system-prompt rule in the same extension.
- Keep the gate blocking every tool call that can change the workspace or that localpi does not know. `read`, `grep`, `find`, and `ls` are read-only and run without a dialog; `bash` stays behind the gate, because a bash command can write, and an unknown tool stays behind the gate too. Keep `--approve-read-tools` and `LOCALPI_APPROVE_READ_TOOLS` as the escape hatches that put read-only tools back behind the gate.
- Keep the gate blocking every tool call without a terminal when approval is on and the tool can change the workspace. Do not auto-approve, and do not silently turn approval off, in a non-interactive run.
- Keep a visible status item while approval is off, so a session never runs unguarded without a sign on screen.
- Do not make approval the default choice for other tools. Keep the dialog as the only approval surface.

## Theme and Colors

localpi uses the Catppuccin Mocha palette for the Pi session and for its own terminal output.

- Keep the palette in `src/localpi/catppuccin.ts` as the single source of truth. Build both the Pi theme file and localpi's own output colors from it. Do not copy hex values into other modules.
- Write the Pi theme to `<state-dir>/pi-themes/catppuccin-mocha.json`. Do not write into the Pi config directory that pi-factory owns, and do not touch a user's global Pi themes or settings.
- Always load the theme with `--theme <path>` so `/settings` can offer it. Add `--use-theme catppuccin-mocha` only when the user did not forward `--use-theme`.
- Skip the theme entirely when the user forwards `--no-themes`. Respect `--use-theme`, `--theme`, and `--no-themes` as the escape hatches. Do not add a localpi flag that duplicates them.
- Keep every Pi theme color token defined. Pi requires all of them, and a missing token breaks the theme.
- Keep localpi's own output plain when the stream is not a TTY, when `NO_COLOR` is set, or when `TERM` is `dumb`. Support `FORCE_COLOR` for forced color.
- Color a label or a message prefix only. Do not color inside a value, because tests and scripts assert on plain substrings.

## Pi TUI Integration

localpi is a launcher and integration layer for Pi. It must not replace, bypass, or reimplement Pi's native TUI for interactive user workflows.

When a feature affects the interactive experience, implement it by extending or configuring Pi's own TUI:

- Prefer Pi extensions, Pi config files, Pi provider/model registry entries, and Pi-native UI components.
- Launch the normal Pi TUI for interactive modes and let Pi own rendering, input handling, streaming, session state, slash commands, and lifecycle.
- Do not create a parallel readline prompt, custom selector, separate terminal UI, or headless loop when the user expectation is to be inside Pi.
- Do not force print mode, JSON mode, RPC mode, or repeated one-shot Pi processes for a feature that should be visible in the live TUI.
- Only use non-interactive Pi launches for explicitly non-interactive commands, tests, status/list/stop commands, or scripted smoke checks.

Concrete examples:

- Model selection at startup should use Pi's native model selector through an extension, scoped to the models localpi discovered. It should not use a localpi-owned dropdown, readline prompt, or preselect a model behind the user's back.
- `/model` behavior should remain Pi's native model-selection flow, with localpi contributing provider/model config so the right local models appear there.
- Demo mode should launch the normal Pi TUI once and drive prompts through a Pi extension, for example by sending the initial prompt on `session_start` and followup prompts after `turn_end`. It should not run a hidden loop of separate print-mode Pi processes.
- Thinking controls should extend Pi's slash-command or settings behavior. They should not introduce a separate localpi control surface that conflicts with Pi's TUI.
- Session settings should use Pi's own dialog components, for example `ctx.ui.select` for a list with the current value marked, and `ctx.ui.notify` for the result. Do not build a localpi-owned settings screen.
- Do not register a command name that Pi already uses. Pi owns built-ins such as `/settings`, `/model`, `/thinking`, `/session`, and `/reload`. Check the built-in list before choosing a name, and rename the localpi command if it conflicts.

## Thinking

Pi owns the thinking level. localpi starts Pi from the remembered level and must not reimplement the control.

- Do not register a `/thinking` command. Pi owns that name, and Pi skips a conflicting extension command in autocomplete.
- Keep only the persistence hooks: `thinking_level_select` and `session_shutdown`. They save the level Pi selected into `<state-dir>/settings.json`.
- Keep the saved level a passthrough. Save the level Pi reports, and let the settings reader ignore a value localpi does not support.
- Keep `--thinking` and `LOCALPI_THINKING` as the non-interactive startup controls.
