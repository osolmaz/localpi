# localpi

Localpi is a Swiss army knife for running Pi with local inference engines.

By default, Localpi discovers available local providers, lets you choose when more than one model is loaded, points Pi at the selected model, and writes Pi config for the other discovered models so `/model` can switch among them during the session.

Localpi is meant to be the practical bridge from Pi to local inference stacks such as llama.cpp/`llama-server`, vLLM, SGLang, LM Studio, Ollama, and custom provider endpoints. llama.cpp is the default engine: Localpi probes a running llama.cpp server first and prefers its loaded models.

Localpi is intentionally generic. It does not contain classifier prompts, dataset workflows, GitHub routing logic, or final-schema output machinery. Structured classifier runs belong in caller tools such as `localpager-agent`.

See:

- [Runtime Specification](docs/runtime-specification.md)
- [Design Principles](docs/design-principles.md)

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
- bounded Gemma/llama-server reasoning controlled by `--thinking`
- in-session `/thinking` (Pi's own command) and `/approval` (localpi's) for changing session settings
- local state under `~/.local/state/localpi`

The approval gate makes failed or denied tool calls explicit to the model so the model does not claim that a blocked command ran.

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
Deny                              # block the call
```

A blocked call and a cancelled dialog do not run, and the model is told that the call was blocked.

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
~/repos/localpi (main) · ↑3.2k ↓100 R3.2k CH99.5% · 9.8%/33k      (llama.cpp) ternary-bonsai-2-27b-pq2_0
```

The line holds, from left to right:

- the working directory and the git branch,
- the token totals, the cache read, and the cache hit rate of the session,
- the context use as a percentage of the window,
- the engine that serves the model, then the model itself.

The engine label comes from the provider localpi built the catalog with, so it is read, not guessed. A
model from a provider with no known engine shows no label. When the model reports reasoning, the line
also shows the thinking level, the same way Pi does.

One number never appears twice at the same time. While the model runs, the context moves to the live
line, and the status line shows the rest. When the session is idle, the context returns to the status
line.

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
- `--base-url <url>`: OpenAI-compatible endpoint for LM Studio or custom endpoints
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
- `--demo`: endlessly run Pi prompts inside the normal Pi TUI until interrupted or Pi exits; requires an explicit non-`auto` model
- `--demo-initial-prompt <text>`: first demo prompt
- `--demo-followup-prompt <text>`: repeated demo prompt after the first run
- `--demo-initial-prompt-file <path>`: UTF-8 file for the first demo prompt
- `--demo-followup-prompt-file <path>`: UTF-8 file for repeated demo prompts
- `--no-approval`: start with the tool approval gate off for the session
- `--approve-read-tools`: also ask before read-only tools (`read`, `grep`, `find`, `ls`)
- `--stats <off|line|full>`: status detail level. Default: `full`, or the last saved `/stats` choice
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
- `LOCALPI_PROVIDERS_FILE`
- `LOCALPI_MODEL_PROFILE`
- `LOCALPI_MODEL_REASONING`
- `LOCALPI_MODEL_THINKING_FORMAT`
- `LOCALPI_STATE_DIR`
- `LOCALPI_SESSION_DIR`
- `LOCALPI_PI_CMD`
- `LOCALPI_CONTEXT_WINDOW`
- `LOCALPI_MAX_TOKENS`
- `LOCALPI_LLAMA_SERVER`
- `LOCALPI_HOST`
- `LOCALPI_PORT`
- `LOCALPI_GPU_LAYERS`
- `LOCALPI_PARALLEL`
- `LOCALPI_CHAT_TEMPLATE`
- `LOCALPI_TOOLS`
- `LOCALPI_THINKING`
- `LOCALPI_STATS`
- `LOCALPI_APPROVE_READ_TOOLS`
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
