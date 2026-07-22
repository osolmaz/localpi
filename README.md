# localpi

Localpi is a Swiss army knife for running Pi with local inference engines.

By default, Localpi discovers available local providers, lets you choose when more than one model is loaded, points Pi at the selected model, and writes Pi config for the other discovered models so `/model` can switch among them during the session.

Localpi is meant to be the practical bridge from Pi to local inference stacks such as llama.cpp/`llama-server`, vLLM, SGLang, LM Studio, Ollama, and custom provider endpoints.

Localpi is intentionally generic. It does not contain classifier prompts, dataset workflows, GitHub routing logic, or final-schema output machinery. Structured classifier runs belong in caller tools such as `localpager-agent`.

See:

- [Runtime Specification](docs/runtime-specification.md)

## Install

```bash
npm install -g localpi
```

During development:

```bash
npm run localpi -- --status
```

After build:

```bash
node dist/src/cli/main.js --status
```

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
- an approval gate before every tool call
- token speed and token count status while responses stream
- bounded Gemma/llama-server reasoning controlled by `--thinking`
- an in-session `/thinking` command for changing Pi's active thinking level
- local state under `~/.local/state/localpi`

The approval gate makes failed or denied tool calls explicit to the model so the model does not claim that a blocked command ran.

## Diffusion Canvas Visualizer

Diffusion LLM servers such as DiffusionGemma on vLLM denoise a whole canvas of
tokens internally and only stream tokens when a canvas converges and commits.
Clients therefore see bursts of text separated by silent denoising intervals,
which makes streaming look stalled even when the server is fast.

`--diffusion-canvas` loads a Pi widget above the editor that visualizes this
process live. The widget is maintained in this repository as a standalone Pi
package, [`packages/diffusion-canvas`](packages/diffusion-canvas/), so it can
also be installed into plain Pi; localpi bundles it.

It has two modes:

- **live** (truthful): when the server exposes the `/v1/diffusion/events` side
  channel, the widget renders the real intermediate canvas on every denoising
  step: accepted tokens mixed with the sampler's renoise tokens, converging
  into the committed text. This requires a vLLM build with canvas streaming
  (see the package [README](packages/diffusion-canvas/README.md) for the
  fork install one-liner) served with `--diffusion-stream-canvas`.
- **simulated** (fallback, labeled): without the side channel, the widget
  shows glyph noise during the real denoising silence and resolves each
  commit burst into the real text. Burst boundaries, commit timing, and step
  counts are real; the glyphs are illustrative.

In both modes a stats line shows real numbers: commits, tokens per commit,
commit interval, smoothed tok/s, and denoising steps per canvas from the
server's Prometheus `/metrics` endpoint when available.

```bash
localpi --runtime vllm --model nvidia/diffusiongemma-26B-A4B-it-NVFP4 --diffusion-canvas
```

The widget also works in demo mode:

```bash
localpi --demo --model nvidia/diffusiongemma-26B-A4B-it-NVFP4 --diffusion-canvas
```

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

Demo mode requires an explicit model, opens the normal Pi TUI, and keeps one live Pi session so followup prompts continue from the first prompt while Pi owns streaming, tok/s status, slash commands, and exit behavior.

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

In an interactive session, use `/thinking` to pick a level or `/thinking high` to set one directly. This changes Pi's active thinking level for later turns and saves it for the next localpi launch. For managed `llama-server`, the server-side reasoning budget is still chosen at startup because changing it requires restarting the local server process.

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

## Options

- `--runtime <auto|llama-server|lmstudio|vllm|openai-compatible>`: runtime backend. Default: `auto`
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
- `--pi-command <command>`: Pi launch command
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
- `--no-approval`: disable the tool approval gate
- `--no-token-status`: disable the token status extension
- `--diffusion-canvas`: show a diffusion canvas visualizer widget above the editor
- `--no-diffusion-canvas`: disable the diffusion canvas visualizer
- `--status`: print runtime, model, and Pi config status
- `--stop`: stop the managed `llama-server` process
- `--list`: list configured model aliases

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
- `LOCALPI_DIFFUSION_CANVAS`
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
