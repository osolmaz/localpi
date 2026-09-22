# Localpi Design Principles

This document records the principles that shape localpi. Use it to decide how a new feature
should look, and to judge whether a proposed change fits the project.

## Simple

Localpi does one job: connect Pi to local inference engines, then get out of the way.

- Prefer the smallest change that solves the real problem.
- Prefer one obvious way to do a thing over three configurable ways.
- Do not add a second mechanism when the first one only needs a small extension.
- Keep output short. A status line that reads well at a glance beats a dashboard.
- Do not build infrastructure for a problem you can observe directly.

## Unopinionated

Localpi has a default for every choice, and none of the defaults are permanent.

- Pick a sensible default, then make it changeable.
- Never hard-code one vendor's behavior into another vendor's path.
- Detect the engine instead of assuming it. When detection is impossible, say so and continue.
- Report facts, not verdicts. If a model is unloaded, tell the user; do not silently load it.
- When localpi cannot know something (for example, a token rate before the first token), show
  nothing rather than a guess.
- Keep measurements honest. Label estimated values as estimates.

## Customizable

Every default must have an escape hatch, and the escape hatch must be easy to find.

- Follow a fixed precedence order: command-line flag, environment variable, saved setting, default.
- Save what the user changes during a session so the next launch keeps it.
- Expose the same setting through the flag, the environment, and the in-session command when that
  costs little.
- Keep user settings in `<state-dir>/settings.json`. Never scatter settings across files.
- Never edit files that Pi owns. Write generated parts into the localpi state directory.

## Pi-native

Pi is the user interface. Localpi configures Pi and launches it.

- Do not replace Pi's TUI, and do not add a parallel UI.
- Use Pi extension APIs: `setWorkingMessage`, `setStatus`, `appendEntry`, `registerCommand`.
- Prefer the documented Pi API over a local workaround. If the API is missing, propose it upstream
  instead of building a private channel.
- Generated extensions must depend only on the public Pi extension API and Node built-ins.
- Keep generated code readable, because users can open it in `<state-dir>/pi-extensions/`.

## Explicit and safe

- Announce what localpi starts, stops, or reuses before doing it.
- Never stop, unload, or reconfigure a server that localpi did not start.
- Fail loudly with an actionable message, then stop. Do not guess a fix.
- Keep tool approval explicit, and report denied calls back to the model.
- Treat unknown input as unknown. Validate JSON at the boundary, then trust the typed value inside.

## Worked example: the status display

The status display shows the same principles in a small feature.

1. **Simple.** One line answers "is this machine keeping up?" The line holds elapsed time, output
   tokens, token rate, and context use. Nothing else.
2. **Unopinionated.** Localpi does not impose colors, layout, or thresholds on users. The display
   uses the active theme. Context coloring starts at 80 percent and 95 percent, and those numbers
   are visible in one file.
3. **Customizable.** `--stats off|line|full` sets the mode. `LOCALPI_STATS` sets it for a shell.
   `/stats` changes it during a session and saves the result to `<state-dir>/settings.json`.
   `--no-token-status` stays as a short alias for `--stats off`. The tool approval gate works the
   same way, with `/approval on|off`: on by default, off on request, and session-scoped, because a
   user who turns approval off does not want that choice to survive a restart.
4. **Pi-native.** The display is a generated Pi extension. It uses `setWorkingMessage` for the live
   line, `appendEntry` for the transcript summary, and `registerCommand` for `/stats`. It writes
   complete lines, so Pi keeps ownership of layout and wrapping. Pi owns the footer and already
   shows context usage there, so localpi adds no footer item and never prints the same numbers
   twice at the same time.
5. **Explicit.** Prefill progress comes from the llama.cpp `/slots` endpoint. When that endpoint is
   missing or slow, localpi stops polling and shows elapsed time instead of inventing a percentage.

The three modes exist because users want different amounts of information:

| Mode   | Live line | Transcript entry | Engine label |
| ------ | --------- | ---------------- | ------------ |
| `off`  | no        | no               | no           |
| `line` | yes       | no               | no           |
| `full` | yes       | yes              | yes          |

## Worked example: the default look

localpi picks the look and lets the user replace it.

1. **Simple.** One palette file holds the colors. Both the Pi theme file and localpi's own terminal
   colors come from it, so the launcher and the session match.
2. **Unopinionated.** Catppuccin Mocha is the default, not a rule. `--no-themes` removes the theme,
   `--use-theme <name>` selects another one, and `NO_COLOR` removes color from localpi's output.
3. **Customizable.** The theme file lives in the localpi state directory, so a user can read it,
   copy it, or edit it. Localpi never edits global Pi themes or settings.
4. **Explicit.** localpi says which theme it loads only when it changes the session. Colors stay out
   of piped output, so scripts keep the plain text.

## Using the principles

Before you add a feature, answer these questions in the pull request:

- Which single problem does this solve?
- Which default do I choose, and how does a user change it?
- Which existing flag, environment variable, or command already covers part of this?
- What does the feature show when the information is unavailable?
- Which generated file or state file does this touch, and is that the right home for it?
