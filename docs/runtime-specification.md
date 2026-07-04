# Runtime Specification

Localpi is the local runtime launcher for Pi.

It should make the common local-model path one command while keeping the selected provider and model explicit and inspectable.

## Goals

- Run Pi against local open-weight models without hand-editing Pi config.
- Discover local providers by default and select from the loaded model catalog.
- Support LM Studio and vLLM as built-in OpenAI-compatible providers.
- Keep managed `llama-server` as an optional fallback when no external model is loaded.
- Keep the tool generic: no classifier prompts, topic schemas, dataset generation, or final-schema output.
- Keep large model memory usage predictable by managing only one localpi-owned `llama-server` process at a time.

## Runtimes

### `auto`

Default runtime.

Localpi:

- probes built-in LM Studio and vLLM endpoints
- loads configured OpenAI-compatible providers from `--providers-file`, `LOCALPI_PROVIDERS_FILE`, or `LOCALPI_MODELS_FILE`
- includes the localpi-owned `llama-server` catalog as startable fallback entries when available
- selects the only loaded model automatically
- opens Pi's native model selector when multiple loaded models are available in an interactive TTY
- never prompts in non-interactive runs; automation can pin a model with concrete `--provider` and `--model` values
- treats `--provider` without `--model` as catalog scoping, not as a concrete model choice
- skips automatic managed `llama-server` fallback when the configured `llama-server` command is unavailable
- writes Pi config for all launch-time loaded catalog entries so Pi `/model` can switch among them

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

Provider registry JSON can define additional OpenAI-compatible providers:

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

## Out Of Scope

- `--final-schema`
- `final_json`
- JSON schema validation for final answers
- classifier retry policy
- GitHub issue or pull request fetching
- reposhell-specific behavior
- dataset generation
