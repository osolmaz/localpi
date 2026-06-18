# localpi

Localpi is a local Pi launcher for open-weight models.

By default, Localpi discovers available local providers, lets you choose when more than one model is loaded, points Pi at the selected model, and writes Pi config for the other discovered models so `/model` can switch among them during the session.

Localpi supports LM Studio, vLLM, custom OpenAI-compatible servers, and an optional managed `llama-server` fallback.

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

This uses the default `auto` runtime. If exactly one model is loaded locally, Localpi selects it. If multiple models are loaded in an interactive terminal, Localpi boots Pi with a temporary default and opens Pi's native model selector. If no external model is loaded and `llama-server` is installed, Localpi can fall back to the managed `llama-server` default. Thinking starts as `off` unless `--thinking` or `LOCALPI_THINKING` sets another startup level.

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

Run an endless non-interactive demo:

```bash
localpi --demo
```

Demo mode keeps one generated Pi session across iterations so followup prompts continue from the first prompt.

Override the demo prompts:

```bash
localpi --demo --demo-initial-prompt-file ./prompts/story.txt --demo-followup-prompt "Continue."
```

Pin a model alias:

```bash
localpi --model gemma-e4b -p "write a detailed implementation plan"
```

Use a bounded reasoning budget with managed `llama-server`:

```bash
localpi --model gemma-12b --thinking low -p "classify this item"
```

In an interactive session, use `/thinking` to pick a level or `/thinking high` to set one directly. This changes Pi's active thinking level for later turns. For managed `llama-server`, the server-side reasoning budget is still chosen at startup because changing it requires restarting the local server process.

For managed `llama-server`, thinking levels map to server-side reasoning:

| Level     | llama-server reasoning                   |
| --------- | ---------------------------------------- |
| `off`     | `--reasoning off`                        |
| `minimal` | `--reasoning on --reasoning-budget 32`   |
| `low`     | `--reasoning on --reasoning-budget 128`  |
| `medium`  | `--reasoning on --reasoning-budget 512`  |
| `high`    | `--reasoning on --reasoning-budget 2048` |
| `xhigh`   | `--reasoning on --reasoning-budget 8192` |

The default is `off`.

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
- `--tools <list>`: Pi tools allow list. Default: `read,bash,edit,write,grep,find,ls`
- `--thinking <off|minimal|low|medium|high|xhigh>`: Pi thinking level and managed `llama-server` reasoning budget. Default: `off`
- `--demo`: endlessly run Pi non-interactive prompts until interrupted or Pi exits non-zero
- `--demo-initial-prompt <text>`: first demo prompt
- `--demo-followup-prompt <text>`: repeated demo prompt after the first run
- `--demo-initial-prompt-file <path>`: UTF-8 file for the first demo prompt
- `--demo-followup-prompt-file <path>`: UTF-8 file for repeated demo prompts
- `--no-approval`: disable the tool approval gate
- `--no-token-status`: disable the token status extension
- `--status`: print runtime, model, and Pi config status
- `--stop`: stop the managed `llama-server` process
- `--list`: list configured model aliases

## Environment

- `LOCALPI_RUNTIME`
- `LOCALPI_MODEL`
- `LOCALPI_PROVIDER`
- `LOCALPI_BASE_URL`
- `LOCALPI_PROVIDERS_FILE`
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
- `LOCALPI_DEMO`
- `LOCALPI_DEMO_INITIAL_PROMPT`
- `LOCALPI_DEMO_FOLLOWUP_PROMPT`
- `LOCALPI_DEMO_INITIAL_PROMPT_FILE`
- `LOCALPI_DEMO_FOLLOWUP_PROMPT_FILE`
- `LOCALPI_MODELS_FILE`

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

## Development

```bash
npm run format
npm run lint
npm run typecheck
npm test
npm run build
npm run check
```
