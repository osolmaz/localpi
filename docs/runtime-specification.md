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
- writes the `--api-key` value as the generated Pi provider key, exactly as given, so an environment reference such as `${HF_TOKEN}` or a `!command` keeps the secret out of the Pi config. The default is `local`, which local engines accept and ignore

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

localpi never infers a capability from a model name. Thinking support comes from the flags, then the profile, then the server. For a loaded llama.cpp model, localpi posts the same one-message chat to `/apply-template` twice, with `chat_template_kwargs.enable_thinking` true and false. When the two rendered prompts differ, the chat template honors the switch, so the Pi model config gets `reasoning: true` and `thinkingFormat: "qwen-chat-template"`, which sends that generic switch. When the prompts are the same, or the endpoint fails, the model gets no thinking controls. vLLM, LM Studio, and other OpenAI-compatible servers report nothing, so a model served with a reasoning parser needs a profile with `capabilities.reasoning`.

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

Pi owns stdout. Localpi writes its own diagnostics, including the connection summary
and catalog warnings, to stderr, so a machine-readable Pi mode such as `--mode rpc`
or `--mode json` stays parseable and a batch run keeps a clean stdout.

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
- writes a launcher script into `<state-dir>/acp/`, and sets `PI_ACP_PI_COMMAND` to that script, because the adapter starts Pi itself and passes only its own arguments. The script quotes the Pi program and every argument, so a program path with a space survives, and it execs Pi with the complete launch line of a normal launch, so the models file, the settings file, the extensions, the system prompt, the theme, and the tool flags stay the same
- passes the environment a normal launch uses: the Pi config directory, the provider base URL, the API key name, the thinking level, and the session directory
- requires an explicit model from the flag, the environment, or a model profile, because there is no TTY, and fails with one clear message instead of printing a picker
- keeps stdout for protocol bytes only, and writes diagnostics, warnings, and startup notes to stderr
- refuses `--demo`, a forwarded Pi `--mode`, forwarded Pi session flags, and forwarded prompts, because the adapter owns the session
- refuses the immediate commands together with a command-line `--acp`, and lets a command-line immediate command win over an environment-set `LOCALPI_ACP=1`, the way `LOCALPI_DEMO` behaves
- refuses a Pi command that is localpi itself, and sets `LOCALPI_ACP=0` for the child, so a spawned child cannot re-enter ACP mode
- runs a different adapter build only when `LOCALPI_ACP_ADAPTER` names its entrypoint
- leaves the thinking budget and the model profile limits unchanged, and never invents a smaller reply cap than the declared one

The adapter spawns Pi as `pi --mode rpc --no-themes`, adds `--session <path>` when a session path exists, and does not pass `--no-extensions`, so Pi extension discovery stays enabled. Approval dialogs reach the ACP client, because the adapter forwards Pi extension UI requests as ACP permission requests.

Pi has no ACP mode of its own. ACP support always comes from the adapter, and localpi only configures it and launches it.

## Continue On Truncation

`localpi --continue-on-truncation <n>` and `LOCALPI_CONTINUE_ON_TRUNCATION=<n>` continue a Pi turn that stopped because it reached the output token limit, so a run finishes its answer instead of ending with a half-written reply.

- `n` is a positive integer and is the maximum number of extra continuations
- the feature is off by default. With no flag and no environment variable, a normal launch, an ACP launch, and demo mode behave exactly as they do today
- follows the usual precedence, command-line flag, environment variable, then default
- treats `0` from the environment as off, so an inherited value can be disabled without dropping the variable
- fails an invalid value with one clear message and exit code 2
- detects the length stop on the turn-end hook, and continues only for that reason
- leaves a truncated turn that already asked for a tool alone, because Pi runs the tool and keeps going on its own
- sends exactly one follow-up user message that tells the model to continue where it stopped and not to repeat earlier text
- counts continuations per session, and stops after the limit, so the feature cannot loop forever
- never continues a turn that ended for another reason, including a normal stop, a tool-only turn, an error stop, and a user cancellation
- writes diagnostics to stderr only, and keeps stdout free for protocol bytes and batch output
- is not a default extension. Localpi installs the guard extension only when the feature is enabled. When it is enabled, the guard is part of the extensions localpi writes, so an ACP launch uses it too
- leaves the thinking budget, the model profile limits, and the ACP contract unchanged

The guard changes no served limit. It reacts to the stop reason Pi reports, so a run that reached the declared output cap continues inside the declared limits.

## Stop Thinking

Localpi always installs the `stop-thinking.ts` Pi extension. While an assistant message is in its
thinking phase, `ctrl+shift+s`, a click on the button above the editor, or `/stop-thinking` stops the
thinking and asks for the answer. `docs/stop-thinking.md` describes the implementation.

- The button shows after the thinking has run for `--stop-thinking-delay` seconds
  (`LOCALPI_STOP_THINKING_DELAY`, default `5`, `0` at once). The key and the command work for the
  whole thinking phase.
- In `message_end`, the extension finishes the stopped message with the stop reason `stop`, so Pi
  shows the stop notice instead of "Operation aborted". An Escape abort stays unchanged.

- The extension aborts the running request, keeps the partial thinking, and starts one new turn with
  a displayed custom message (`localpi-stop-thinking`) that holds the instruction.
- For a llama.cpp or managed llama-server provider, `before_provider_request` replaces that
  instruction with an assistant message whose `reasoning_content` holds the partial thinking, and
  sets `continue_final_message: "content"` and `add_generation_prompt: false`. llama.cpp writes the
  model's own end-of-thinking marker. A stop before the first thinking token sends one newline as the
  thinking, because llama.cpp skips an empty continuation.
- For vLLM, the request keeps the instruction and sets `chat_template_kwargs.enable_thinking: false`.
- For other engines, the request keeps the instruction only.
- The engine comes from the launch-time provider map, never from a model name.
- Only the request that ends with the instruction changes. Every other request stays byte-identical.
- `--stop-thinking-key` and `LOCALPI_STOP_THINKING_KEY` change the key, and `off` removes it.

Pi routes mouse input only in fullscreen mode, so localpi adds `--tui-mode fullscreen` to an
interactive launch. A forwarded `--tui-mode` wins, `LOCALPI_TUI_MODE` sets the default, and print,
JSON, RPC, and ACP launches get no TUI flag.

## Web Mode

`localpi --web` serves localpi in the browser through `@osolmaz/pi-factory-web`, with the same Pi
app definition as a terminal launch.

- The page lists the saved sessions for the working directory and runs one localpi Pi process per
  open session in a ghostty-web terminal. Sessions can be resumed, renamed, and deleted.
- Web mode uses one Catppuccin flavor for the page and the Pi theme: `--web-theme` or
  `LOCALPI_WEB_THEME`, `latte` by default, or `frappe`, `macchiato`, or `mocha`. localpi writes the
  matching `catppuccin-<flavor>` Pi theme. Terminal launches keep Catppuccin Mocha.
- The web runner starts Pi in fullscreen mode, so localpi adds no `--tui-mode` flag in web mode.
- The server listens on `--web-host` (default `127.0.0.1`), answers to the loopback names, the listen
  host, and `--web-allowed-hosts`, and requires the random token from the printed URL.
- Web mode rejects `--acp`, `--demo`, and forwarded `-p`, `--print`, or `--mode`. An immediate
  command such as `--list` wins over an exported `LOCALPI_WEB`.

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
