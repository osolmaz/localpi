# Runtime Specification

Localpi is the local runtime launcher for Pi.

It should make the common local-model path one command while keeping the backend choice explicit and inspectable.

## Goals

- Run Pi against local open-weight models without hand-editing Pi config.
- Use managed `llama-server` by default.
- Support LM Studio as an alternate OpenAI-compatible runtime.
- Keep the tool generic: no classifier prompts, topic schemas, dataset generation, or final-schema output.
- Keep large model memory usage predictable by managing only one localpi-owned `llama-server` process at a time.

## Runtimes

### `llama-server`

Default runtime.

Localpi:

- resolves a model alias or GGUF path
- starts `llama-server` if the selected model is not already served
- reuses an existing server on the configured port if it is already serving the requested model
- exposes the server through an OpenAI-compatible `/v1` endpoint
- writes Pi config that points at that endpoint
- stops the old localpi-owned server before starting a different managed model
- reports any detected LM Studio loaded models before starting a large managed model

### LM Studio

Explicit alternate runtime.

Localpi:

- requires `--runtime lmstudio`
- defaults to `http://127.0.0.1:1234/v1`
- does not start or stop LM Studio
- probes `/v1/models` and fails clearly if the requested model is not available

### Custom OpenAI-Compatible Endpoint

Explicit alternate runtime.

Localpi:

- requires `--runtime openai-compatible`
- requires `--base-url`
- uses `/v1/models` for discovery
- avoids assuming it can start, stop, or unload the backend

## Model Selection

`--model` should accept:

- a configured alias such as `gemma-12b` or `gemma-e4b`
- an LM Studio model id
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
- token status: show live output token estimate while streaming and final exact token stats when usage data is available

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
