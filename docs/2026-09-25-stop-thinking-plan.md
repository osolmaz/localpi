---
date: 2026-09-25
author: Onur Solmaz
title: Stop thinking and answer for localpi
tags:
  - localpi
  - pi
  - plan
---

# Stop thinking and answer for localpi

## Status

Selected plan. This document is the only source to follow for the feature.

## Goal

Give the user a way to end a local model's thinking phase early and get the answer now. ChatGPT had
this as a "Stop thinking and reply" button. Local reasoning models tend to overthink, and on local
hardware every extra thinking token costs real time, so this matters more for localpi than for a
hosted model.

The user gets two controls inside the normal Pi TUI:

- a key combination, `ctrl+shift+s` by default;
- a clickable button that shows only while the model thinks.

## How the model is told to stop

A reasoning model writes its thinking between two markers, for example `<think>` and `</think>` for
Qwen and Bonsai, or `[THINK]` and `[/THINK]` for Mistral. To stop the thinking, the client must put
the end marker into the model's output and let the model continue from there. The marker depends on
the model, so a client should not hard-code it.

llama.cpp already does this natively. Its chat endpoint accepts a final assistant message plus
`continue_final_message: "content"`. The server renders the conversation, adds the partial
thinking after the model's own start marker, closes it with the model's own end marker, and
generates the answer from that point (`common/chat-auto-parser-generator.cpp` and the
template-specific paths in `common/chat.cpp`). The installed runtime (b10711) has this feature.

So the flow is:

1. The user presses the key or clicks the button while the assistant message is in its thinking
   phase.
2. The extension keeps the partial thinking text and aborts the running request.
3. When Pi settles, the extension starts one new turn with a short hidden instruction message.
4. In `before_provider_request`, the extension rewrites only that request. For a llama.cpp provider
   it replaces the instruction with an assistant message that holds the partial thinking in
   `reasoning_content`, and sets `continue_final_message: "content"` with
   `add_generation_prompt: false`. llama.cpp then writes the end
   marker itself, and the model answers.
5. The answer streams as a normal assistant message. Tool calls after the answer work as usual.

Engine behavior, taken from the launch-time engine map, never guessed from a model name:

| Engine                          | Behavior                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| llama.cpp, managed llama-server | Native: partial thinking plus `continue_final_message: "content"`. The server inserts the end-of-thinking marker. |
| vLLM                            | Instruction message plus `chat_template_kwargs.enable_thinking: false` for that one request.                      |
| other or unknown engines        | Instruction message only. localpi does not guess engine-specific fields.                                          |

When the user stops before the first thinking token arrived, llama.cpp would skip an empty
continuation. The extension then sends one newline as the thinking, so the server still closes the
thinking at once. A check against the live server showed the rendered prompt `<think>\n</think>` and
a direct answer. `enable_thinking: false` is not a safe llama.cpp fallback, because many chat
templates ignore it.

## Where the button lives

Pi routes mouse input to components only in its fullscreen TUI mode (`--tui-mode fullscreen`). In
regular mode the terminal owns the mouse and the scrollback, so no click reaches Pi.

Therefore localpi starts Pi in fullscreen mode by default:

- localpi adds `--tui-mode fullscreen` to an interactive launch when the user did not forward
  `--tui-mode`;
- a forwarded `--tui-mode regular` (for example `localpi -- --tui-mode regular`, or just
  `localpi --tui-mode regular`) keeps regular mode, like the `--use-theme` rule;
- `LOCALPI_TUI_MODE=regular|fullscreen` sets the default for a shell;
- localpi does not add the flag for print, JSON, RPC, or ACP launches.

The button is a widget above the editor, set with `ctx.ui.setWidget` only while the model thinks. It
is a plain component with `render` and `handleMouse`, so it needs no import beyond the Pi extension
API. In regular mode the widget still shows the key hint, and a click does nothing.

## Interface

| Interface                              | Meaning                                                         |
| -------------------------------------- | --------------------------------------------------------------- |
| `ctrl+shift+s`                         | Default key while the model thinks.                             |
| `--stop-thinking-key <key\|off>`       | Change the key, or `off` to remove the key and the button hint. |
| `LOCALPI_STOP_THINKING_KEY=<key\|off>` | Same from the environment.                                      |
| `/stop-thinking`                       | The same action as a command, useful over RPC.                  |
| click on the button                    | The same action in fullscreen mode.                             |
| `LOCALPI_TUI_MODE=<mode>`              | Default Pi TUI mode, `fullscreen` unless set.                   |

`ctrl+shift+s` is free in Pi's default bindings and in Ghostty's default bindings. A terminal must
report `ctrl+shift` combinations separately (the Kitty keyboard protocol, which Ghostty, Kitty,
WezTerm, and Windows Terminal support). Where the terminal cannot, the user can pick another key
with the flag, and the button and `/stop-thinking` still work.

Pressing the key when the model is not thinking shows a short notice and does nothing else.

## Contract impact

- **Session state:** one custom message (`customType: "localpi-stop-thinking"`) per stop. It is the
  user's real instruction, so later turns see why the thinking ended. The aborted assistant message
  stays as Pi records it. No other session entry changes.
- **Other persistent data:** none. The key comes from the flag or the environment.
- **Pi internals:** none.
- **Public API:** `registerShortcut`, `registerCommand`, `registerMessageRenderer`, `message_update`,
  `message_end`, `agent_settled`, `before_provider_request`, `ctx.abort`, `ctx.ui.setWidget`,
  `ctx.ui.notify`, `pi.sendMessage`.

## Where the code goes

- `src/pi/extension-sources/stop-thinking.ts`: the generated extension source, with the key and the
  engine map baked in like the other generated sources.
- `src/pi/extensions.ts`: always write the extension, so `/stop-thinking` and the button always
  exist. The key `off` removes only the key binding and its hint.
- `src/localpi/options.ts`: `stopThinkingKey`, `tuiMode`, their flags, environment variables, usage
  lines, and validation.
- `src/pi/app.ts`: the fullscreen launch argument.

## Deliverables

1. The extension source and its wiring.
2. The options, flags, environment variables, usage lines, and validation.
3. Tests: option parsing; the fullscreen argument rules; the stop action in the thinking phase and
   outside it; the payload rewrite for llama.cpp, vLLM, unknown engines, and empty thinking; the
   rewrite touching only the continuation request; the button click; the generated-extension
   typecheck.
4. A README section, and entries in `docs/runtime-specification.md` and `AGENTS.md`.
5. A live check against a real llama.cpp server with a thinking model.

## Acceptance

- `npm run check` passes.
- A live llama.cpp request with `continue_final_message: "content"` returns an answer without new
  thinking after a stop.
- A normal session without a stop sends byte-identical requests.

## Out of scope

- A release to npm.
- Changes to Pi, pi-factory, or llama.cpp.
- A thinking budget per request. The existing `--thinking-budget` stays as it is.
