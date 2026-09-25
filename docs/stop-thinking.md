# Stop Thinking: How It Works

This document describes how localpi implements the stop-thinking control. The selected plan is
`docs/2026-09-25-stop-thinking-plan.md`. This document records the implementation as it is now,
including the changes made after the plan.

## What the user sees

While an assistant message is in its thinking phase, the user can stop the thinking and get the
answer now:

- the key, `ctrl+shift+s` by default;
- the `[ Stop thinking and answer ]` button above the editor, which shows after the model has thought
  for more than 5 seconds by default;
- the `/stop-thinking` command.

The key and the command work for the whole thinking phase, also before the button shows. Outside the
thinking phase, they show "The model is not thinking now." and do nothing else.

After a stop, the transcript shows the thinking that arrived, the line
`Stopped thinking. Answering now.`, and then the answer.

## Where the code is

| File                                        | Role                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `src/pi/extension-sources/stop-thinking.ts` | Generates the Pi extension `<state-dir>/pi-extensions/stop-thinking.ts`.  |
| `src/pi/extensions.ts`                      | Always writes the extension, with the key, the delay, and the engine map. |
| `src/localpi/options.ts`                    | `--stop-thinking-key`, `--stop-thinking-delay`, and `LOCALPI_TUI_MODE`.   |
| `src/pi/app.ts`                             | Adds `--tui-mode fullscreen` to an interactive launch.                    |
| `tests/stop-thinking-extension.test.ts`     | Drives the generated extension with a fake Pi.                            |

The generated extension uses only the public Pi extension API and has no runtime imports. The key,
the delay, and the engine lists are baked into its source at launch, like the other generated
extensions.

## Pi APIs used

| API                                   | Use                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `message_update`                      | Find the thinking phase and keep the partial thinking text.             |
| `ctx.ui.setWidget`                    | Show and hide the button.                                               |
| `registerShortcut`, `registerCommand` | The key and `/stop-thinking`.                                           |
| `ctx.abort`                           | End the running request.                                                |
| `message_end`                         | Keep the final thinking text, and finish the stopped message as `stop`. |
| `agent_settled`                       | Start the answer turn with `pi.sendMessage`.                            |
| `before_provider_request`             | Rewrite the one request that answers the stop.                          |
| `registerMessageRenderer`             | Draw the stop notice.                                                   |

## The thinking phase

The extension watches `message_update`. An assistant message is in its thinking phase when it has a
thinking block and no tool call and no text with visible characters yet. The extension keeps the
text of all thinking blocks, so a stop always knows the latest partial thinking.

When the phase starts, the extension starts a timer for the button delay. The button shows when the
timer fires and the phase is still running. When the phase ends, because the answer or a tool call
starts, because the message ends, or because of a stop, the extension clears the timer and hides the
button. A delay of `0` shows the button at once.

## The stop sequence

1. **Stop.** The key, the click, or the command records the provider of the current model and the
   partial thinking, hides the button, and calls `ctx.abort()`.
2. **Finish the stopped message.** In `message_end`, the extension takes the thinking text from the
   final aborted message, because it can hold tokens that arrived after the last update. It then
   returns the same message with the stop reason `stop` and without an error message. Pi applies an
   extension's `message_end` replacement before the TUI draws the message and before it saves the
   message, so the transcript shows no "Operation aborted". Pi keeps the abort request apart from
   the message, so the run still ends. If the model had finished on its own before the abort landed,
   the extension drops the stop and changes nothing.
3. **Start the answer turn.** In `agent_settled`, the extension calls `pi.sendMessage` with a custom
   message (`customType: "localpi-stop-thinking"`, `display: true`, `triggerTurn: true`). Its content
   is the instruction "Stop thinking now. Give your answer based on the reasoning you have so far."
   Pi runs work requested in `agent_settled` after all settled handlers finish. The public API has no
   way to start a turn without a message, so this message is required.
4. **Rewrite the answer request.** In `before_provider_request`, the extension rewrites a request
   only when its last message is exactly the stop instruction. Every other request stays
   byte-identical. The rewrite depends on the engine, as described below. A retry of the same
   request gets the same rewrite, because the continuation stays active until the answer turn
   settles.
5. **End.** The next `agent_settled` ends the continuation. A new stop can start at any time,
   including during the answer turn, for example when an engine without the native path thinks
   again.

A stop by the user's own Escape key is not changed: Pi shows "Operation aborted" as usual.

## Engine behavior

The engine comes from the launch-time provider map (`engineEntries`), never from a model name or a
base URL.

### llama.cpp and the managed llama-server

The extension replaces the instruction with an assistant message and two request fields:

```json
{
  "messages": [
    "...earlier messages...",
    { "role": "assistant", "content": "", "reasoning_content": "<partial thinking>" }
  ],
  "add_generation_prompt": false,
  "continue_final_message": "content"
}
```

llama.cpp renders the conversation, puts the partial thinking after the model's own start marker,
closes it with the model's own end marker, and generates the answer from there. For Qwen and
Bonsai, the rendered end of the prompt is:

```text
<|im_start|>assistant
<think>
<partial thinking>
</think>
```

localpi never hard-codes the marker. The server takes it from the chat template (see
`common/chat-auto-parser-generator.cpp` in llama.cpp). llama.cpp rejects `continue_final_message`
together with a generation prompt, so the request sets `add_generation_prompt: false`. llama.cpp
skips an empty continuation message, so a stop before the first thinking token sends one newline as
the thinking. When streaming, the server sends only the new answer tokens, not the prefilled
thinking.

This closes the running thinking block. It does not forbid the model to open a new thinking block
later in the answer. Qwen-style models, Bonsai included, did not do so in the live tests.

### vLLM

The request keeps the instruction and adds `chat_template_kwargs.enable_thinking: false`, merged
into any existing `chat_template_kwargs`. This works when the model's chat template reads
`enable_thinking`. The model does not see the partial thinking.

### Other engines

The request keeps the instruction only. localpi does not guess engine-specific fields.

## Session contents

A stop leaves these entries in the session, all of them standard Pi entry types:

- the stopped assistant message with its thinking, saved with the stop reason `stop`;
- the custom message with the instruction, drawn by the renderer as `Stopped thinking. Answering
now.`;
- the assistant message with the answer.

localpi adds no new session fields, entry types, or files. In later turns, the model sees the custom
message as a user message. The thinking-only message has no text, so Pi's OpenAI chat conversion
leaves it out of later requests.

## Display details

- The button renders two lines: the button with its key hint, indented by one column like Pi's
  default `outputPad`, and one empty line that keeps it away from Pi's working line. A widget does
  not receive the configured `outputPad`, so the button uses Pi's default.
- A click counts only on the button text: the left button, on the first line, within the label. The
  button returns `{ handled: true }` for the press too, because Pi sends a click only to a component
  that handled the press.
- Pi routes mouse input to components only in fullscreen mode, so localpi starts interactive Pi with
  `--tui-mode fullscreen`. A forwarded `--tui-mode` wins, `LOCALPI_TUI_MODE` sets the default, and
  print, JSON, RPC, and ACP launches get no TUI flag.
- The stop notice uses the renderer's `outputPad`, so it lines up with the assistant text. Pi already
  puts one empty line above every custom message, so the renderer adds none.

## Endpoint thinking ceiling

For a selected `llama-cpp` or `vllm` provider, `--thinking-phase-output-cap N` opts in to a
request-level ceiling. Pi keeps thinking on but sends an output limit of at most
`N` (`max_tokens` or `max_completion_tokens`) for each request. If the server stops at that ceiling
while the message contains only thinking, localpi asks for an answer through the
same stop-thinking path. For llama.cpp, it continues the partial reasoning as
assistant content. For vLLM, it asks for an answer with
`chat_template_kwargs.enable_thinking: false`. Pi can lower the request's output
limit as the context fills. In that case, localpi sets the thinking ceiling to the
smaller of `N` and half the available output tokens. The continuation can use
up to the remaining tokens for the answer. The same extension handles manual stops, capped
thinking stops, and ordinary truncated answers. It chooses only one follow-up
for each stop.

This is an output-token ceiling for the first request, **not** an exact count of
thinking tokens. If the model starts its answer before `N`, that answer still
uses the first request's remaining tokens. An error, a tool call, an answer
that hits the ceiling, or an abort does not trigger the answer-only path. If
Pi turns thinking off, the ceiling does not apply. The request needs at least
two available output tokens so both phases have room. If the limit is missing
or lower than two, localpi aborts the request and reports an error. The backend
must honor the output ceiling and report a length stop for
this to work. Offline tests cannot confirm either behavior on an endpoint.

The managed `llama-server` keeps its existing `--thinking-budget` option and native
`--reasoning-budget` behavior. This endpoint path neither changes a server nor applies to an
unknown OpenAI-compatible engine. It is off by default.

## Settings

| Setting                                                                | Default        | Meaning                                                      |
| ---------------------------------------------------------------------- | -------------- | ------------------------------------------------------------ |
| `--stop-thinking-key <key\|off>`, `LOCALPI_STOP_THINKING_KEY`          | `ctrl+shift+s` | The key. `off` removes the key and its hint.                 |
| `--stop-thinking-delay <seconds>`, `LOCALPI_STOP_THINKING_DELAY`       | `5`            | Thinking time before the button shows. `0` shows it at once. |
| `LOCALPI_TUI_MODE`, forwarded `--tui-mode`                             | `fullscreen`   | Pi's TUI mode for interactive launches.                      |
| `--thinking-budget <n>`, `LOCALPI_THINKING_BUDGET`                     | unset          | Native managed-server reasoning budget.                      |
| `--thinking-phase-output-cap <n>`, `LOCALPI_THINKING_PHASE_OUTPUT_CAP` | unset          | Optional first-request output ceiling on supported engines.  |

The flag wins over the environment variable. The key needs a terminal that reports `ctrl+shift`
combinations separately (the Kitty keyboard protocol). In tmux, set `extended-keys on`.

## Tests

- `tests/stop-thinking-extension.test.ts` covers the thinking phase, the button delay, the key, the
  click area, the command, the `message_end` replacement, each engine rewrite, the empty-thinking
  case, retries, repeated stops, session resets, and the opt-in endpoint ceiling.
- `tests/generated-extension-types.test.ts` typechecks the generated extension against the installed
  Pi version.
- `tests/options.test.ts` and `tests/pi-config.test.ts` cover the options and the TUI mode rules.

The native path was also checked live against llama.cpp b10711 and the PrismML build `5d80cff` with
Ternary Bonsai 2 27B. Pi ran in fullscreen mode in tmux, and the tests used the key, a mouse click,
and the command.
