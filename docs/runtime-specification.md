# Runtime Specification

Localpi is the local runtime launcher for Pi.

It should make the common local-model path one command while keeping the selected provider and model explicit and inspectable.

## Goals

- Run Pi against local open-weight models without hand-editing Pi config.
- Treat llama.cpp as the default engine and the preferred discovery target.
- Discover local providers by default and select from the loaded model catalog.
- Support llama.cpp, LM Studio, and vLLM as built-in OpenAI-compatible providers.
- Keep managed `llama-server` as an optional fallback when no external model is loaded.
- Keep the tool generic: no classifier prompts, topic schemas, dataset generation, or final-schema output.
- Keep large model memory usage predictable by managing only one localpi-owned `llama-server` process at a time.

## Runtimes

### `auto`

Default runtime.

Localpi:

- probes a running llama.cpp server first, then built-in LM Studio and vLLM endpoints
- loads configured OpenAI-compatible providers from `--providers-file`, `LOCALPI_PROVIDERS_FILE`, or `LOCALPI_MODELS_FILE`
- includes the localpi-owned `llama-server` catalog as startable fallback entries when available
- selects the only loaded model automatically, preferring llama.cpp when several engines have loaded models
- opens Pi's native model selector when multiple loaded models are available in an interactive TTY
- never prompts in non-interactive runs; automation can pin a model with concrete `--provider` and `--model` values
- treats `--provider` without `--model` as catalog scoping, not as a concrete model choice
- skips automatic managed `llama-server` fallback when the configured `llama-server` command is unavailable
- writes Pi config for all launch-time loaded catalog entries so Pi `/model` can switch among them

### `llama-cpp`

Default external engine.

Localpi:

- probes `http://127.0.0.1:8080/v1` by default and is listed first in `auto` discovery
- reads llama.cpp `/v1/models` entries: a model with `status.value` `loaded`, or with no status, is usable
- offers a model with `status.value` `unloaded` as startable only when `/props` reports `models_autoload`, because the llama.cpp router loads it on request
- reports unloaded models that the server will not autoload as a catalog warning instead of claiming they are usable
- reads llama.cpp `meta.n_ctx` as the model context window when the server reports it
- never starts, stops, or unloads an external llama.cpp server

```bash
localpi --runtime llama-cpp
localpi --runtime llama-cpp --base-url http://127.0.0.1:9931/v1 --model ternary-bonsai-2-27b-pq2_0
```

### `llama-server`

Managed runtime.

Localpi:

- resolves a model alias or GGUF path
- starts `llama-server` if the selected model is not already served
- reuses an existing server on the configured port if it is already serving the requested model
- exposes the server through an OpenAI-compatible `/v1` endpoint
- writes Pi config that points at that endpoint
- stops the old localpi-owned server before starting a different managed model
- reports any detected LM Studio loaded models before starting a large managed model
- passes the reasoning flags of the selected thinking level: `--reasoning off` and no budget when
  thinking is off, and `--reasoning on` with a token budget otherwise
- caps thinking with `--thinking-budget <n>` or `LOCALPI_THINKING_BUDGET` when set, where `-1` means
  unrestricted and a positive value replaces the budget of the thinking level
- injects a default message before the end-of-thinking tag when the budget is finite, so a model
  that loops in its thinking still answers
- rewords that message with `--thinking-budget-message <text>` or `LOCALPI_THINKING_BUDGET_MESSAGE`,
  and passes no message flag when the value is empty
- records the reasoning mode, the budget, and the message in the managed server metadata, and
  restarts the owned server when a recorded value changes

The engine reads the thinking tags from the model template, so localpi passes no tag of its own. A
budget of `-1` leaves thinking unrestricted.

### LM Studio

Built-in external OpenAI-compatible provider.

Localpi:

- requires `--runtime lmstudio`
- defaults to `http://127.0.0.1:1234/v1`
- does not start or stop LM Studio
- probes `/v1/models` and fails clearly if the requested model is not available

### vLLM

Built-in external OpenAI-compatible provider.

Localpi:

- requires `--runtime vllm`
- defaults to `http://127.0.0.1:8000/v1`
- does not start or stop vLLM
- probes `/v1/models` and fails clearly if the requested model is not available

### Custom OpenAI-Compatible Endpoint

Explicit alternate runtime.

Localpi:

- requires `--runtime openai-compatible`
- requires `--base-url`
- can use `--provider <id>` to name the generated Pi provider
- uses `/v1/models` for discovery
- avoids assuming it can start, stop, or unload the backend

### Configured Providers

Provider registry JSON can define additional OpenAI-compatible providers, and can override the built-in `llama-cpp` provider with `type: "llama-cpp"`:

```json
{
  "providers": {
    "vllm-qwen": {
      "type": "openai-compatible",
      "name": "vLLM Qwen",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "discover": true
    },
    "llama-cpp": {
      "type": "llama-cpp",
      "name": "llama.cpp",
      "baseUrl": "http://127.0.0.1:9931/v1",
      "discover": true
    }
  }
}
```

A `llama-cpp` provider uses the llama.cpp status and autoload rules described in the `llama-cpp` runtime section. When `baseUrl` is omitted, it defaults to `http://127.0.0.1:8080/v1`.

Set `discover: false` when the endpoint should not be probed during startup. Explicit `--provider <id> --model <id>` can still select that provider and generate Pi config.

## Capability Profiles

OpenAI-compatible `/v1/models` responses do not reliably report local serving capabilities such as reasoning support or Pi's required thinking request format. Localpi can read a local model capability profile with `--model-profile`, `LOCALPI_MODEL_PROFILE`, or `LOCALPAGER_AGENT_PROFILE`.

Example:

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

When the served model id matches `model` or `id`, localpi uses the profile to generate Pi model config. `LOCALPI_MODEL_REASONING` / `LOCALPAGER_AGENT_REASONING` and `LOCALPI_MODEL_THINKING_FORMAT` / `LOCALPAGER_AGENT_THINKING_FORMAT` are explicit overrides.

Name-based capability detection remains fallback behavior. Built-in vLLM Gemma 4 model ids are treated as reasoning-capable with `qwen-chat-template`, matching vLLM Gemma servers launched with `--reasoning-parser gemma4`.

### Image input

A llama.cpp server reports model architecture in `/v1/models`. Localpi reads `architecture.input_modalities` and writes `input: ["text", "image"]` into the Pi model config when the entry lists `image`, so Pi passes image attachments to that model. Every other model is written as `input: ["text"]`.

A model profile states the same fact for a server that reports nothing: add `"image": true` to `capabilities`. The profile wins over the server, so `"image": false` also disables image input for a model that reports it.

The server side must hold up its end: the model needs a multimodal projector, and the server must run with `--mmproj <file>.gguf`. A llama.cpp router passes the projector of a model directory to the child server on its own. Test a model with one real image request before you trust it, because a text-only server answers an image request with text about the prompt, not the picture.

## Model Selection

`--model` should accept:

- a configured alias such as `gemma-12b` or `gemma-e4b`
- an LM Studio model id
- a vLLM model id
- an absolute or relative GGUF path for `llama-server`
- `auto`, which selects the first model reported by the backend

Model aliases are configurable with `LOCALPI_MODELS_FILE`. The built-in defaults cover the local Gemma GGUF paths commonly used on this machine and are easy to override.

## Pi Defaults

Localpi passes these defaults to Pi unless the user overrides them:

```text
tools: read,bash,edit,write,grep,find,ls
thinking: off
state dir: ~/.local/state/localpi
session dir: ~/.local/state/localpi/sessions
```

Localpi installs two default extensions:

- tool approval gate: ask before each tool call, and tell the model clearly when a tool call was blocked
- token status: show live generation speed while streaming, then final prefill and generation rates when usage data is available

## System Prompt

Localpi appends a short system prompt that tells the model:

- it is running through Pi on a local model
- tool calls require user approval
- blocked tool calls did not run
- it should not claim to have used a blocked tool
- it should prefer direct answers when tools are not needed

The prompt should be generic and should not mention localpager, OpenClaw, datasets, or classifier labels.

## ACP Mode

`localpi --acp` and `LOCALPI_ACP=1` start localpi as an ACP agent, so an ACP client such as an editor can drive the same Pi that a normal launch runs.

Localpi:

- follows the usual precedence, command-line flag, environment variable, then default, and keeps a normal launch as the default
- resolves the model and writes the same Pi configuration a normal launch writes before it starts the adapter
- starts the pinned `pi-acp` adapter from `node_modules` on stdio as a child process with inherited stdio, and does not vendor its source
- writes a launcher script into `<state-dir>/acp/`, and sets `PI_ACP_PI_COMMAND` to that script, because the adapter starts Pi itself and passes only its own arguments. The script execs Pi with the complete launch line of a normal launch, so the models file, the settings file, the extensions, the system prompt, the theme, and the tool flags stay the same
- passes the environment a normal launch uses: the Pi config directory, the provider base URL, the API key name, the thinking level, and the session directory
- requires an explicit model from the flag, the environment, or a model profile, because there is no TTY, and fails with one clear message instead of printing a picker
- keeps stdout for protocol bytes only, and writes diagnostics, warnings, and startup notes to stderr
- refuses `--demo`, the immediate commands, a forwarded Pi `--mode`, forwarded Pi session flags, and forwarded prompts, because the adapter owns the session
- refuses a Pi command that is localpi itself, and sets `LOCALPI_ACP=0` for the child, so a spawned child cannot re-enter ACP mode
- runs a different adapter build only when `LOCALPI_ACP_ADAPTER` names its entrypoint
- leaves the thinking budget and the model profile limits unchanged, and never invents a smaller reply cap than the declared one

The adapter spawns Pi as `pi --mode rpc --no-themes`, adds `--session <path>` when a session path exists, and does not pass `--no-extensions`, so Pi extension discovery stays enabled. Approval dialogs reach the ACP client, because the adapter forwards Pi extension UI requests as ACP permission requests.

Pi has no ACP mode of its own. ACP support always comes from the adapter, and localpi only configures it and launches it.

## Out Of Scope

- `--final-schema`
- `final_json`
- JSON schema validation for final answers
- classifier retry policy
- GitHub issue or pull request fetching
- reposhell-specific behavior
- dataset generation
- an ACP server implemented inside localpi, because the adapter is a pinned dependency
- ACP file system or terminal delegation, because Pi reads, writes, and runs commands in its own process
- interactive model selection in ACP mode, because ACP has no terminal
