# localpi

<p align="center">
  <img src="assets/cover.svg" alt="localpi: an unopinionated Pi distribution that makes it easy to test and work with small local models on constrained systems" width="880">
</p>

Localpi is an unopinionated [Pi](https://pi.dev) distribution that makes it easy to test and work with small local models on constrained systems.

By default, Localpi discovers available local providers, lets you choose when more than one model is loaded, points Pi at the selected model, and writes Pi config for the other discovered models so `/model` can switch among them during the session.

Localpi is meant to be the practical bridge from Pi to local inference stacks such as llama.cpp/`llama-server`, vLLM, SGLang, LM Studio, Ollama, and custom provider endpoints. llama.cpp is the default engine: Localpi probes a running llama.cpp server first and prefers its loaded models.

Localpi is intentionally generic. It does not contain classifier prompts, dataset workflows, GitHub routing logic, or final-schema output machinery. Structured classifier runs belong in caller tools such as `localpager-agent`.

A Localpi session keeps its context light. Localpi appends three sentences to Pi's own system prompt, adds no datasets, prompt packs, or memory files, and loads only its own skills directory, so a session starts with about 2.9k tokens of baseline context on the default tool set and a small context window still has room for real work.

See:

- [Runtime Specification](docs/runtime-specification.md)
- [Design Principles](docs/design-principles.md)

## Requirements

- Node.js 22.19.0 or newer, which Pi requires.
- A running inference server: llama.cpp/`llama-server`, LM Studio, vLLM, SGLang, or any OpenAI-compatible endpoint. Localpi never starts, stops, or unloads a server it did not start itself.
- A terminal that Pi supports.

## Install

```bash
npm install -g localpi
```

Or the latest GitHub release directly:

```bash
npm install -g https://github.com/osolmaz/localpi/releases/latest/download/localpi.tgz
```

During development:

```bash
npm run localpi -- --status
```

After build:

```bash
node dist/src/cli/main.js --status
```

## Pi and pi-factory Versions

Localpi launches Pi through `npx -y @earendil-works/pi-coding-agent@latest`, so a normal launch
runs the newest Pi release. Point it somewhere else with `--pi-command`, or `LOCALPI_PI_CMD`, as a
program plus arguments:

```bash
localpi --pi-command "node /opt/pi/bin/pi"
```

Localpi builds its Pi launch on [pi-factory](https://github.com/osolmaz/pi-factory) and keeps that
dependency current. The `@earendil-works/pi-coding-agent` devDependency pins the Pi release that
localpi is written against, and `tests/generated-extension-types.test.ts` typechecks every
generated extension against those types, so Pi extension API drift fails `npm test` instead of
failing at launch.

## Runtime Model

Target default:

```bash
localpi --model gemma-12b
```

This uses the default `auto` runtime. If exactly one model is loaded locally, Localpi selects it. If multiple models are loaded in an interactive terminal, Localpi boots Pi with a temporary default and opens Pi's native model selector. If no external model is loaded and `llama-server` is installed, Localpi can fall back to the managed `llama-server` default. Thinking starts from `--thinking`, `LOCALPI_THINKING`, the last saved Pi thinking level, or `medium`.

LM Studio is explicit:

```bash
localpi --runtime lmstudio --model gemma-4-e4b-it
```

vLLM is explicit:

```bash
localpi --runtime vllm --model qwen
```

Custom OpenAI-compatible endpoints are also supported:

```bash
localpi --runtime openai-compatible --base-url http://127.0.0.1:8000/v1 --model my-model
```

Use `--provider <id>` with `--model <id>` to select a catalog entry without opening the picker. `--provider <id>` by itself only scopes the available choices. Localpi avoids loading multiple heavyweight local runtimes at the same time. When using the managed `llama-server` runtime, it either stops its previous managed server or clearly reports what is already running before starting another model.

## Default Pi Behavior

Localpi launches Pi with:

- default tools: `read,bash,edit,write,grep,find,ls`
- a system prompt that explains local tool approval and local-model limits
- an approval gate before every tool call, which you can turn off for the session with `/approval`
- token speed, prefill progress, and context usage while responses stream
- a Catppuccin Mocha theme for the Pi session, written into `<state-dir>/pi-themes/`
- skills from `<state-dir>/pi-skills/` only, so shared skill directories stay out of the session
- bounded llama-server reasoning controlled by `--thinking`
- in-session `/thinking` (Pi's own command) and `/approval` (localpi's) for changing session settings
- a stop-thinking control: `ctrl+shift+s`, a clickable button, or `/stop-thinking` ends the thinking
  phase and asks for the answer now
- Pi's fullscreen TUI mode, so the transcript scrolls inside Pi and mouse clicks reach the TUI
- local state under `~/.local/state/localpi`

Pi owns stdout. Localpi writes its own diagnostics, including the connection summary and catalog
warnings, to stderr. A machine-readable Pi mode such as `--mode rpc` or `--mode json` therefore stays
parseable, and a batch run keeps a clean stdout.

The approval gate makes failed or denied tool calls explicit to the model so the model does not claim that a blocked command ran.

## Skills

Pi discovers skills from shared directories such as `~/.agents/skills` and `~/.pi/agent/skills`. A
localpi session does not use those. It launches Pi with `--no-skills` and loads only
`<state-dir>/pi-skills/`, so a small local model does not carry skill lists it cannot use.

Put your own localpi skills there, one directory with a `SKILL.md` per skill:

```bash
mkdir -p ~/.local/state/localpi/pi-skills/my-skill
$EDITOR ~/.local/state/localpi/pi-skills/my-skill/SKILL.md
```

Pick the source with `--skills` or `LOCALPI_SKILLS`:

- `own` (default): `--no-skills` plus `<state-dir>/pi-skills/`
- `ambient`: Pi's normal discovery, including `~/.agents/skills` and project `.agents/skills`
- `off`: `--no-skills` and nothing else

An explicit `--skill <path>` still works in every mode, because Pi loads explicit paths even with
`--no-skills`.

## Diffusion Canvas Visualizer

The live diffusion canvas visualizer (watching DiffusionGemma denoise its
answer in the TUI) lives in its own project now:
[diffusionpi](https://github.com/osolmaz/diffusionpi). It is a pi-factory app
bundle plus a standalone Pi widget package; the widget also installs into any
Pi session via `pi install`.

## Tool Approval

Approval is on by default. Every tool call opens a dialog that shows the tool name and its input,
with three choices:

```text
Allow once                        # run this call and keep asking for the next one
Allow all tools for this session  # run every tool call in this session without asking
Deny and stop                     # block the call and end the turn
```

A denied call does not run, the model is told that the call was blocked, and the turn stops instead
of letting the model try another way. Pressing escape in the dialog counts as a deny, so one key
ends the turn. Pi stops the turn when every blocked result in the current tool batch asks for it,
so a batch that also contains an allowed read-only call finishes that call first.

Read-only tools (`read`, `grep`, `find`, `ls`) run without a dialog, because they cannot change the
workspace. `bash` still asks, because a bash command can write. An unknown tool also asks, because
localpi cannot know what it does. Use `--approve-read-tools`, or `LOCALPI_APPROVE_READ_TOOLS=1`, to
put read-only tools behind the gate too.

The dialog choice lasts for this session only. Use the permission setting to change what new
sessions do:

```text
/approval allow   # do not ask in new sessions either
/approval ask     # ask before each tool call (the default)
/approval off     # alias for /approval allow
/approval on      # alias for /approval ask
/approval         # pick ask or allow from a list, with the current value marked
```

The permission setting lives in `<state-dir>/settings.json` as `"permission": "ask" | "allow"`.
Startup reads, in order: `--no-approval` or `LOCALPI_APPROVAL=0`, the saved setting, then the
default `ask`. Use `--no-approval` to start one session without changing the setting.

While approval is off, Pi shows `permission: allow` in the status area, so the state stays visible.

In a non-interactive launch, approval stays on and no dialog is possible, so every tool call is
blocked. That keeps scripted runs from executing tools without a person watching.

## ACP Mode

`--acp` and `LOCALPI_ACP=1` serve the Agent Client Protocol on stdio, so an ACP client such as an
editor can drive the same Pi session that a normal launch runs.

```bash
localpi --acp --model gemma-e4b
LOCALPI_ACP=1 localpi --model gemma-e4b
```

ACP mode:

- resolves the runtime and writes the same Pi configuration a normal launch writes, including
  `<state-dir>/pi-config-runtime/models.json` and `settings.json`
- starts the pinned `pi-acp` adapter from `node_modules` as a child process with inherited stdio
- writes a launcher script to `<state-dir>/acp/pi-launcher.sh` and points `PI_ACP_PI_COMMAND` at it,
  because the adapter starts Pi itself and passes only its own arguments. The script quotes the Pi
  program and every argument, so a path with a space survives, and execs Pi with the full launch line
  a normal launch uses, so the extensions, the system prompt, the theme, and the tool flags stay the
  same
- passes the environment a normal launch uses, and sets `LOCALPI_ACP=0` for the child
- requires an explicit `--model` or `LOCALPI_MODEL`, because there is no terminal for the startup
  model picker
- keeps stdout for protocol bytes only, and writes diagnostics and warnings to stderr
- refuses `--demo`, a forwarded Pi `--mode`, Pi session flags, and forwarded prompts, because the
  adapter owns the session
- refuses `--status`, `--stop`, and `--list` together with `--acp` on the command line, and lets a
  command-line immediate command win over an environment-set `LOCALPI_ACP=1`, as `LOCALPI_DEMO` does
- refuses to start localpi as the adapter's Pi command, so a child cannot re-enter ACP mode

Approval still works: the adapter forwards Pi's extension dialogs to the ACP client, so the client
asks before a tool call runs. The adapter does not pass `--no-extensions`, so Pi extension discovery
stays on.

Pi has no ACP mode of its own. ACP support comes from
[`pi-acp`](https://github.com/svkozak/pi-acp) (MIT), which `package.json` pins to an exact version,
and localpi never vendors its source. Set `LOCALPI_ACP_ADAPTER` to a path to run a different adapter
build.

## Continue On Truncation

`--continue-on-truncation <n>` and `LOCALPI_CONTINUE_ON_TRUNCATION=<n>` continue a reply that the
model cut off at the declared output limit, so a run finishes its answer instead of ending with a
half-written one.

```bash
localpi --model gemma-e4b --max-tokens 4096 --continue-on-truncation 2
LOCALPI_CONTINUE_ON_TRUNCATION=2 localpi --model gemma-e4b
```

`n` is the maximum number of extra continuations. Pi reports a turn that reached the output cap as a
length stop, and localpi sends one follow-up message that asks the model to continue where it
stopped without repeating earlier text. The guard:

- is off by default. With no flag and no environment variable, a normal launch, an ACP launch, and
  demo mode behave exactly as they do today
- takes the flag first, then `LOCALPI_CONTINUE_ON_TRUNCATION`, then off
- treats `LOCALPI_CONTINUE_ON_TRUNCATION=0` as off, so an inherited value can be disabled without
  dropping the variable, and rejects any other value that is not a positive integer with exit code 2
- reacts only to the length stop, never to a normal stop, an error, an abort, or a tool call
- leaves a truncated turn that already asked for a tool alone, because Pi runs the tool and keeps
  going on its own
- counts continuations per session, stops at the limit, and prints one line to stderr when the reply
  was still cut off
- writes its notes to stderr only, so stdout stays free for a batch run
- changes no served limit. `--max-tokens` and `--context-window` keep their meaning, and the guard
  only reacts to the stop reason Pi reports

The always-generated `stop-thinking.ts` extension also owns this optional guard. With no limit,
it sends no truncation follow-up. In ACP mode, the same Pi extension handles both controls.

## Stop Thinking and Answer

A local reasoning model can think for a long time before it answers. Press `ctrl+shift+s`, click
the `[ Stop thinking and answer ]` button, or run `/stop-thinking` while the model thinks, and the
model answers with the reasoning it has so far.

The button shows above the editor after the model has thought for more than 5 seconds, so a short
thinking phase stays quiet. The key and `/stop-thinking` work for the whole thinking phase, and
outside it they only show a short notice. `--stop-thinking-delay <seconds>` or
`LOCALPI_STOP_THINKING_DELAY` changes the delay, and `0` shows the button at once.

How localpi stops the thinking depends on the engine that serves the model:

- **llama.cpp and the managed llama-server:** localpi aborts the running request and sends one new
  request that continues the partial thinking as content (`continue_final_message: "content"`).
  llama.cpp then writes the model's own end-of-thinking marker, for example `</think>`, and the model
  answers from that point. localpi never hard-codes the marker.
- **vLLM:** localpi aborts the request and asks for the answer with thinking turned off for that one
  reply (`chat_template_kwargs.enable_thinking: false`).
- **other engines:** localpi aborts the request and sends only the instruction to answer now.

The session keeps a short record of each stop (`Stopped thinking. Answering now.`), so later turns
know why the thinking ended.

```bash
localpi --stop-thinking-key alt+s    # use another key
localpi --stop-thinking-key off      # no key; the button and /stop-thinking stay
LOCALPI_STOP_THINKING_KEY=ctrl+shift+x localpi
localpi --stop-thinking-delay 0      # show the button as soon as the thinking starts
```

`docs/stop-thinking.md` describes how the feature is implemented.

The key needs a terminal that reports `ctrl+shift` combinations separately, through the Kitty
keyboard protocol (Ghostty, Kitty, WezTerm, recent Windows Terminal). In tmux, set
`extended-keys on`. When a terminal cannot report the key, pick another one or use the button.

### Fullscreen TUI mode

Pi sends mouse clicks to extension components only in its fullscreen TUI mode, so localpi starts
interactive Pi with `--tui-mode fullscreen`. In fullscreen mode the transcript scrolls inside Pi,
the editor and status line stay fixed at the bottom, and dragging selects and copies text.

- `localpi --tui-mode regular` forwards Pi's own flag and keeps regular mode for one launch
- `LOCALPI_TUI_MODE=regular` keeps regular mode for a shell
- print, JSON, RPC, and ACP launches get no TUI flag

In regular mode the button still shows the key hint, but a click does not reach Pi.

## Web Mode

`localpi --web` runs localpi in the browser. The page has a session list on the left, like Open
WebUI, and the normal localpi Pi TUI on the right, in a
[ghostty-web](https://github.com/coder/ghostty-web) terminal. There is no shell and no settings page.

```bash
localpi --web                     # opens the browser on a free port
localpi --web --web-port 8421 --no-browser
localpi --web --web-host 100.64.0.1 --web-allowed-hosts box.tailnet.ts.net   # over Tailscale
```

- **Sessions.** The list shows the saved sessions for the current folder, newest first. "New
  session" starts localpi. A saved session resumes when you pick it. The `⋯` menu next to a session
  renames or deletes it. A rename of a running session goes through Pi, the same way as `/name`.
- **Status.** A purple dot means the agent responds, an orange dot means it waits for you, for
  example for a tool approval.
- **Running sessions.** Each open session keeps its own Pi process while localpi runs, also when the
  browser is closed. Stop localpi with Ctrl-C to stop them all. The sessions stay on disk.
- **Look.** Web mode uses Catppuccin Latte for the page and for the Pi theme. `--web-theme frappe`,
  `macchiato`, or `mocha` picks a darker flavor. The terminal font is Monaspace Argon, which the page
  serves itself.
- **Keys.** `Ctrl+Shift+S` and the stop button work in the page. Browsers keep some keys, such as
  `Ctrl+W` and `Ctrl+T`, for themselves.
- **Access.** The server listens on `127.0.0.1` unless `--web-host` says otherwise, and every
  request needs the random token in the printed URL. Anyone with the URL can use the agent, which
  can run commands, so keep the URL private and listen only on loopback or on a private network.

| Setting                       | Environment                 | Default     |
| ----------------------------- | --------------------------- | ----------- |
| `--web`                       | `LOCALPI_WEB=1`             | off         |
| `--web-port <n>`              | `LOCALPI_WEB_PORT`          | `0` (free)  |
| `--no-browser`                | `LOCALPI_WEB_OPEN=0`        | opens       |
| `--web-host <host>`           | `LOCALPI_WEB_HOST`          | `127.0.0.1` |
| `--web-allowed-hosts <names>` | `LOCALPI_WEB_ALLOWED_HOSTS` | none        |
| `--web-theme <flavor>`        | `LOCALPI_WEB_THEME`         | `latte`     |

Web mode cannot be combined with `--acp`, `--demo`, or a forwarded `-p` or `--mode`. The page comes
from [`@osolmaz/pi-factory-web`](https://github.com/osolmaz/pi-factory/tree/main/packages/web).

## llama.cpp (Default Engine)

llama.cpp is Localpi's default local engine.

```bash
localpi
```

With the default `auto` runtime, Localpi probes a running llama.cpp server at `http://127.0.0.1:8080/v1` first. A loaded llama.cpp model wins automatic selection ahead of LM Studio, vLLM, and the managed `llama-server` fallback. Localpi reads llama.cpp `/v1/models` status: a model is usable when it is loaded or the server does not report status, and an unloaded model is offered only when `/props` reports `models_autoload`. Localpi never starts, stops, or unloads an external llama.cpp server.

Run explicitly against llama.cpp:

```bash
localpi --runtime llama-cpp
localpi --runtime llama-cpp --base-url http://127.0.0.1:8080/v1 --model ternary-bonsai-2-27b-pq2_0
```

Point at a llama.cpp server on another port with a provider registry entry:

```json
{
  "providers": {
    "llama-cpp": {
      "type": "llama-cpp",
      "baseUrl": "http://127.0.0.1:9931/v1",
      "discover": true
    }
  }
}
```

### Image input

When a llama.cpp model takes images, Localpi says so in the Pi model config, so the `read` tool and `@file` attachments can send a picture to that model. Localpi reads the fact from the server: an entry in `/v1/models` that lists `image` in `architecture.input_modalities` gets `input: ["text", "image"]`. Every other model stays text-only. No model name is used to guess this.

An engine that reports nothing can be described with a model profile:

```json
{
  "id": "qwen3-vl-8b",
  "model": "qwen3-vl-8b",
  "capabilities": { "image": true }
}
```

The profile wins over the server in both directions, so `"image": false` also turns image input off for a model that reports it.

The server must load a multimodal projector for the model, which a llama.cpp router does on its own from the model directory. Check it with one real image request before you rely on it.

## Status Display

The status display answers one question: is this machine keeping up? It shows elapsed time, output
tokens, token rate, and context use. Pick a mode with `--stats`:

| Mode             | Status line | Live line | Transcript entry |
| ---------------- | ----------- | --------- | ---------------- |
| `off`            | Pi's own    | no        | no               |
| `line`           | localpi     | yes       | no               |
| `full` (default) | localpi     | yes       | yes              |

The status line is one row. Localpi replaces Pi's two-row footer with one line that carries the same
facts plus the engine label next to the model:

```text
~/repos/localpi (main) · ↑3.2k ↓100 R3.2k CH99.5% · 43.8 tok/s · 9.8%/33k      (llama.cpp) ternary-bonsai-2-27b-pq2_0
```

The line holds, from left to right:

- the working directory and the git branch,
- the token totals, the cache read, and the cache hit rate of the session,
- the token rate of the last finished turn,
- the context use as a percentage of the window,
- the engine that serves the model, then the model itself.

The engine label comes from the provider localpi built the catalog with, so it is read, not guessed. A
model from a provider with no known engine shows no label. When the model reports reasoning, the line
also shows the thinking level, the same way Pi does.

One number never appears twice at the same time. While the model runs, the live line owns the token
rate and the context use, and the status line shows the rest. When the session is idle, the rate of
the last finished turn and the context return to the status line, so the speed stays visible after
the answer ends. The status line drops the rate first when the row is too narrow.

The live line replaces Pi's plain `Working` text while the model runs:

```text
Working (1.8s · 100 out · 55.6 tok/s · ctx 34k/131k (26%))
```

During prefill, the same line reports progress through the prompt:

```text
Working (prefill 25% · 5k/20k tok · 3.2s · ctx 20k/33k (61%))
```

Prefill progress needs a llama.cpp server, because it reads the server's `/slots` endpoint. Localpi
polls that endpoint only for llama.cpp runtimes. When the endpoint is missing or slow, localpi stops
polling and shows elapsed prefill time instead.

In `full` mode, each finished turn also adds one dim transcript line:

```text
10s · 438 out · 43.8 tok/s · 8.4k in · prefill 0.4s · ctx 34k/131k (26%)
```

Context colors use the active theme: normal below 80 percent, warning from 80 percent, error from
95 percent. When Pi reports no token counts, the live line falls back to the context percentage
alone.

Localpi shows the engine label in `line` and `full` mode. In `off` mode localpi leaves the footer and
the working line to Pi.

Change the mode during a session with `/stats`:

```text
/stats          # pick a mode from a list
/stats line     # or pass the mode directly
```

`/stats` saves the choice to `<state-dir>/settings.json`, so the next launch keeps it. Pass
`--stats <mode>` or set `LOCALPI_STATS` to override the saved value for one launch.

## Catppuccin Theme

Localpi gives each Pi session the Catppuccin Mocha palette. It writes its own copy of the theme to
`<state-dir>/pi-themes/catppuccin-mocha.json`, loads it into Pi, and selects it for the session. The
theme covers the full Pi TUI: messages, tool cards, diffs, syntax highlighting, and the localpi
status display.

Localpi writes its own copy for a good reason. A localpi session uses a Pi config directory inside
the localpi state directory, so Pi does not load the themes from your global Pi setup.

The theme belongs to the session only. Localpi never edits your global Pi themes or settings.

Localpi's own output uses the same palette: labels are `overlay1`, warnings are `peach`, and errors
are `red`. Colors are truecolor and appear only on a terminal. Piped output stays plain, and
`NO_COLOR` turns color off.

Escape hatches:

- `localpi --no-themes` starts the session with no theme at all.
- `localpi --use-theme onur-dark` selects your own theme instead. The Catppuccin file is still
  loaded, so `/settings` can offer it.
- `localpi --theme <path>` adds another theme file, as Pi does in a normal session.
- `FORCE_COLOR=1` forces color in localpi's own output; `NO_COLOR=1` removes it.

## LM Studio Alternative

LM Studio exposes an OpenAI-compatible endpoint, usually:

```text
http://127.0.0.1:1234/v1
```

Load Gemma in LM Studio:

```bash
~/.lmstudio/bin/lms server start
~/.lmstudio/bin/lms load gemma-4-e4b-it -y
```

Then run localpi against LM Studio explicitly:

```bash
localpi --runtime lmstudio --model gemma-4-e4b-it
```

## Usage

Run Pi interactively on the default local model:

```bash
localpi
```

Run a non-interactive Pi prompt:

```bash
localpi -p "summarize this repo"
```

Run an endless TUI demo:

```bash
localpi --demo --model gemma-e4b
```

Demo mode requires an explicit model, opens the normal Pi TUI, and keeps one live Pi session so followup prompts continue from the first prompt while Pi owns streaming, tok/s status, slash commands, and exit behavior. Under the hood it loads the shared [pi-demo-mode](https://github.com/osolmaz/pi-demo-mode) extension, configured through the `--demo-*` flags below.

Override the demo prompts:

```bash
localpi --demo --model gemma-e4b --demo-initial-prompt-file ./prompts/story.txt --demo-followup-prompt "Continue. Try to write as long as possible."
```

Pin a model alias:

```bash
localpi --model gemma-e4b -p "write a detailed implementation plan"
```

Use a bounded reasoning budget with managed `llama-server`:

```bash
localpi --model gemma-12b --thinking low -p "classify this item"
```

In an interactive session, use Pi's own `/thinking` command to pick a level or to set one directly. This changes Pi's active thinking level for later turns. Localpi remembers the level Pi selected and starts the next localpi launch from it. For managed `llama-server`, the server-side reasoning budget is still chosen at startup because changing it requires restarting the local server process.

Localpi does not register its own `/thinking` command, because Pi already owns that name.

For managed `llama-server`, thinking levels map to server-side reasoning:

| Level     | llama-server reasoning                   |
| --------- | ---------------------------------------- |
| `off`     | `--reasoning off`                        |
| `minimal` | `--reasoning on --reasoning-budget 32`   |
| `low`     | `--reasoning on --reasoning-budget 128`  |
| `medium`  | `--reasoning on --reasoning-budget 512`  |
| `high`    | `--reasoning on --reasoning-budget 2048` |
| `xhigh`   | `--reasoning on --reasoning-budget 8192` |

The fallback default is `medium`.

Localpi never guesses thinking support from a model name. For a loaded llama.cpp model, it asks the
server: it renders a prompt through `/apply-template` with thinking on and off, and when the two
prompts differ, Pi gets thinking controls that send `chat_template_kwargs.enable_thinking`. Then
`--thinking off` and Pi's `/thinking off` turn thinking off on the server. For vLLM, LM Studio, or
another engine that does not report this, declare it with `--model-reasoning` or a model profile.

Point at vLLM:

```bash
localpi --runtime vllm --model qwen -p "review the src directory"
```

Point at a different OpenAI-compatible local server:

```bash
localpi --runtime openai-compatible --base-url http://127.0.0.1:8000/v1 -p "review the src directory"
```

Pass a Pi flag that localpi also owns after `--`:

```bash
localpi --model gemma-e4b -- --model some-pi-level-value
```

Stop the managed `llama-server` runtime:

```bash
localpi --stop
```

## Demo Grid and Recording

The `localpi grid` and `localpi record` subcommands moved to
[demowall](https://github.com/osolmaz/demowall), a standalone tool that runs
N copies of any command in a tiled tmux wall and records tmux sessions to
video. A wall of localpi demo sessions is:

```bash
demowall grid --concurrency 4 --start -- localpi --demo --model gemma-e4b
demowall record --session demowall-<timestamp> --out demo.mp4 --seconds 60
```

## Options

- `--runtime <auto|llama-server|llama-cpp|lmstudio|vllm|openai-compatible>`: runtime backend. Default: `auto`, which prefers llama.cpp
- `--provider <id>`: catalog provider id to use, for example `lmstudio` or `vllm`
- `--model <alias|id|path|auto>`: model alias, model id, or GGUF path
- `--ctx <n>` / `--context-window <n>`: model context window
- `--max-tokens <n>`: generated model max output tokens
- `--continue-on-truncation <n>`: continue a reply cut off by the output limit, up to `n` times. Off by default, and `LOCALPI_CONTINUE_ON_TRUNCATION=<n>` sets the same limit
- `--base-url <url>`: OpenAI-compatible endpoint for LM Studio or custom endpoints
- `--api-key <value>`: Pi provider API key for this run. A literal value, an environment reference such as `${NAME}`, or a `!command`. Default: `local`. `LOCALPI_API_KEY` sets the same value
- `--server-command <path>`: `llama-server` executable path
- `--llama-server <path>`: alias for `--server-command`
- `--host <host>`: managed `llama-server` host. Default: `127.0.0.1`
- `--port <n>`: managed `llama-server` port. Default: `18194`
- `--gpu-layers <n>`: managed `llama-server` GPU layers. Default: `999`
- `--parallel <n>`: managed `llama-server` parallel slots. Default: `1`
- `--chat-template <path>`: optional llama.cpp chat template file
- `--state-dir <path>`: runtime state directory. Default: `~/.local/state/localpi`
- `--session-dir <path>`: Pi session directory. Default: `<state-dir>/sessions`
- `--pi-command <command>`: Pi launch command as a program and its arguments. Quotes group words, and the command runs without a shell. Default: `npx -y @earendil-works/pi-coding-agent@latest`, so a normal launch runs the newest Pi release
- `--providers-file <path>`: provider registry JSON
- `--model-profile <path>`: local model capability profile JSON
- `--model-reasoning <bool>`: override generated Pi reasoning capability
- `--model-thinking-format <deepseek|qwen-chat-template>`: override generated Pi thinking format
- `--tools <list>`: Pi tools allow list. Default: `read,bash,edit,write,grep,find,ls`
- `--thinking <off|minimal|low|medium|high|xhigh>`: Pi thinking level and managed `llama-server` reasoning budget. Default: last saved level, then `medium`
- `--thinking-budget <n>`: native reasoning budget for a managed `llama-server`. `-1` leaves it unrestricted. It does not cap an external endpoint.
- `--thinking-phase-output-cap <n>`: optional first-request total output ceiling for a selected `llama-cpp` or `vllm` provider. It is off by default. See [Stop Thinking](docs/stop-thinking.md#endpoint-thinking-ceiling).
- `--thinking-budget-message <text>`: text the server injects before the end-of-thinking tag when the budget runs out. An empty value passes no message. Default: `Reasoning budget reached. Stop thinking and answer now.`
- `--demo`: endlessly run Pi prompts inside the normal Pi TUI until interrupted or Pi exits; requires an explicit non-`auto` model
- `--demo-initial-prompt <text>`: first demo prompt
- `--demo-followup-prompt <text>`: repeated demo prompt after the first run
- `--demo-initial-prompt-file <path>`: UTF-8 file for the first demo prompt
- `--demo-followup-prompt-file <path>`: UTF-8 file for repeated demo prompts
- `--acp`: serve the Agent Client Protocol on stdio through the pinned `pi-acp` adapter; requires an explicit non-`auto` model
- `--no-approval`: start with the tool approval gate off for the session
- `--approve-read-tools`: also ask before read-only tools (`read`, `grep`, `find`, `ls`)
- `--stats <off|line|full>`: status detail level. Default: `full`, or the last saved `/stats` choice
- `--stop-thinking-key <key|off>`: key that stops the thinking phase and asks for the answer. Default: `ctrl+shift+s`. `off` removes the key, and the button and `/stop-thinking` stay. `LOCALPI_STOP_THINKING_KEY` sets the same key
- `--stop-thinking-delay <seconds>`: thinking time before the stop thinking button shows. Default: `5`. `0` shows it at once. `LOCALPI_STOP_THINKING_DELAY` sets the same delay
- `--web`: run localpi in the browser, with a session list and the Pi TUI. `LOCALPI_WEB=1` does the same. See [Web Mode](#web-mode)
- `--web-port <n>`, `--no-browser`, `--web-host <host>`, `--web-allowed-hosts <names>`, `--web-theme <latte|frappe|macchiato|mocha>`: web mode port, browser opening, listen address, extra host names, and Catppuccin flavor
- `--skills <own|ambient|off>`: skill sources. Default: `own`, which loads only `<state-dir>/pi-skills/` and turns off shared discovery such as `~/.agents/skills`. `ambient` keeps Pi's own discovery, and `off` loads no skills
- `--no-skills`: load no skills. Alias for `--skills off`
- `--no-token-status`: disable the token status extension. Alias for `--stats off`
- `--status`: print runtime, model, and Pi config status
- `--stop`: stop the managed `llama-server` process
- `--list`: list configured model aliases

## Pi Helper Tools

Pi manages two helper binaries, `fd` and `rg`, and downloads them into its own bin directory when
they are missing from `PATH`. Localpi starts Pi in offline mode, so Pi skips that download. A start
that shows

```
Warning: fd not found. Offline mode enabled, skipping download.
```

means `fd` is not installed, and Pi falls back to a slower file search. Fix it in either way:

- Install `fd`, for example with `brew install fd`. Pi uses the `fd` that is in `PATH`.
- Run `PI_OFFLINE=0 localpi` once, and let Pi download `fd` into its own bin directory.

Localpi keeps offline mode on by default, because a local-model session should not make network
calls without a reason. `PI_OFFLINE` is pi-factory's default and passes straight through, so an
explicit `PI_OFFLINE=0` or `PI_OFFLINE=1` always wins.

## Environment

- `LOCALPI_RUNTIME`
- `LOCALPI_MODEL`
- `LOCALPI_PROVIDER`
- `LOCALPI_BASE_URL`
- `LOCALPI_API_KEY`
- `LOCALPI_PROVIDERS_FILE`
- `LOCALPI_MODEL_PROFILE`
- `LOCALPI_MODEL_REASONING`
- `LOCALPI_MODEL_THINKING_FORMAT`
- `LOCALPI_STATE_DIR`
- `LOCALPI_SESSION_DIR`
- `LOCALPI_PI_CMD`
- `LOCALPI_CONTEXT_WINDOW`
- `LOCALPI_MAX_TOKENS`
- `LOCALPI_CONTINUE_ON_TRUNCATION`
- `LOCALPI_LLAMA_SERVER`
- `LOCALPI_HOST`
- `LOCALPI_PORT`
- `LOCALPI_GPU_LAYERS`
- `LOCALPI_PARALLEL`
- `LOCALPI_CHAT_TEMPLATE`
- `LOCALPI_TOOLS`
- `LOCALPI_THINKING`
- `LOCALPI_THINKING_BUDGET`
- `LOCALPI_THINKING_BUDGET_MESSAGE`
- `LOCALPI_STATS`
- `LOCALPI_SKILLS`
- `LOCALPI_STOP_THINKING_KEY`
- `LOCALPI_STOP_THINKING_DELAY`
- `LOCALPI_TUI_MODE`
- `LOCALPI_WEB`
- `LOCALPI_WEB_PORT`
- `LOCALPI_WEB_OPEN`
- `LOCALPI_WEB_HOST`
- `LOCALPI_WEB_ALLOWED_HOSTS`
- `LOCALPI_WEB_THEME`
- `LOCALPI_APPROVE_READ_TOOLS`
- `LOCALPI_ACP`
- `LOCALPI_ACP_ADAPTER`
- `LOCALPI_DEMO`
- `LOCALPI_DEMO_INITIAL_PROMPT`
- `LOCALPI_DEMO_FOLLOWUP_PROMPT`
- `LOCALPI_DEMO_INITIAL_PROMPT_FILE`
- `LOCALPI_DEMO_FOLLOWUP_PROMPT_FILE`
- `LOCALPI_MODELS_FILE`
- `LOCALPAGER_AGENT_PROFILE`
- `LOCALPAGER_AGENT_REASONING`
- `LOCALPAGER_AGENT_THINKING_FORMAT`

`LOCALPI_MODELS_FILE` may point at a JSON file with this shape:

```json
{
  "models": {
    "my-model": {
      "id": "my-model-id",
      "path": "/path/to/model.gguf",
      "contextWindow": 32768,
      "chatTemplate": "/path/to/template.jinja"
    }
  }
}
```

Provider registries use the same file or `LOCALPI_PROVIDERS_FILE`:

```json
{
  "providers": {
    "vllm-qwen": {
      "type": "openai-compatible",
      "name": "vLLM Qwen",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "discover": true
    }
  }
}
```

Use `discover: false` for endpoints that should not be probed during startup. They can still be selected explicitly with `--provider vllm-qwen --model <id>`.

Model capability profiles can fill in metadata that OpenAI-compatible servers do not expose through `/v1/models`, such as vLLM reasoning support:

```json
{
  "id": "gemma4-26b-a4b-nvfp4",
  "model": "nvidia/Gemma-4-26B-A4B-NVFP4",
  "base_url": "http://127.0.0.1:8000/v1",
  "client": {
    "context_window": 32768,
    "max_tokens": 4096
  },
  "capabilities": {
    "reasoning": true,
    "thinking_format": "qwen-chat-template"
  }
}
```

`LOCALPAGER_AGENT_PROFILE`, `LOCALPAGER_AGENT_REASONING`, and `LOCALPAGER_AGENT_THINKING_FORMAT` are accepted as aliases so LocalPager Agent can pass the same profile metadata through to localpi.

## Related Projects

- [Pi](https://pi.dev) is the coding agent this distribution launches. Pi owns model detection, the
  tool loop, streaming, slash commands, and the session. Its source is
  [earendil-works/pi](https://github.com/earendil-works/pi).
- [pi-factory](https://github.com/osolmaz/pi-factory) builds the Pi launch plan, the launch
  environment, and the runtime config a session uses.
- [pi-demo-mode](https://github.com/osolmaz/pi-demo-mode) is the shared extension behind demo mode.
- [pi-acp](https://github.com/svkozak/pi-acp) is the adapter that ACP mode pins, for the
  [Agent Client Protocol](https://agentclientprotocol.com). Localpi keeps no copy of its source.
- Inference stacks: [llama.cpp](https://github.com/ggml-org/llama.cpp) and its `llama-server`,
  [LM Studio](https://lmstudio.ai), [vLLM](https://github.com/vllm-project/vllm),
  [SGLang](https://github.com/sgl-project/sglang), and [Ollama](https://ollama.com).

## Development

```bash
npm run format
npm run lint
npm run typecheck
npm test
npm run build
npm run check
```

`npm run check` is the default gate. It does not run mutation testing, because the mutation run takes
minutes. Run `npm run mutate` by hand once in a while; the `mutation` workflow runs it weekly.
