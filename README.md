# localagent

Localagent is Pi with the model wiring prefilled for a local OpenAI-compatible endpoint.

It does not know about any project-specific workflow. It discovers the local model, writes a temporary Pi config under local state, and forwards the rest of the command line to Pi.

## Install

```bash
npm install
npm run build
```

During development:

```bash
npm run localagent -- --status
```

After build:

```bash
node dist/src/cli/main.js --status
```

## Local Model

Localagent defaults to LM Studio's OpenAI-compatible server:

```text
http://127.0.0.1:1234/v1
```

Load Gemma in LM Studio:

```bash
~/.lmstudio/bin/lms server start
~/.lmstudio/bin/lms load gemma-4-e4b-it -y
```

Check what localagent will use:

```bash
localagent --status
```

## Usage

Run Pi interactively on the local model:

```bash
localagent
```

Run a non-interactive Pi prompt:

```bash
localagent -p "summarize this repo"
```

Pin a specific local model id:

```bash
localagent --model gemma-4-e4b-it -p "write a detailed implementation plan"
```

Point at a different OpenAI-compatible local server:

```bash
localagent --base-url http://127.0.0.1:8000/v1 -p "review the src directory"
```

Pass a Pi flag that localagent also owns after `--`:

```bash
localagent --model gemma-4-e4b-it -- --model some-pi-level-value
```

## Structured Output

For workflows that need machine-readable final answers, use a final-only schema pass in Pi print mode: let Pi use tools normally, then force JSON schema on the final answer and validate it.

See [docs/structured-output.md](docs/structured-output.md).

Example:

```bash
localagent --final-schema ./examples/schemas/binary-classifier.schema.json -p "classify whether this issue is release-blocking: <text>"
```

## Options

- `--base-url <url>`: local OpenAI-compatible endpoint. Default: `http://127.0.0.1:1234/v1`
- `--model <id|auto>`: model id. Default: `auto`, meaning first id returned by `/v1/models`
- `--status`: print model/config status and exit
- `--provider-id <id>`: generated Pi provider id. Default: `local-openai`
- `--state-dir <path>`: runtime state directory. Default: `~/.local/state/localagent`
- `--session-dir <path>`: Pi session directory. Default: `<state-dir>/sessions`
- `--pi-command <command>`: Pi launch command. Default: `npx -y @earendil-works/pi-coding-agent@latest`
- `--thinking <level>`: Pi thinking level. Default: `off`
- `--context-window <n>`: generated model context window override. By default, localagent uses model metadata when the server reports it and otherwise leaves this unset.
- `--max-tokens <n>`: generated model max output tokens. Default: `8192`
- `--timeout-ms <n>`: `/v1/models` probe timeout. Default: `3000`
- `--final-schema <path>`: force the final answer through a JSON schema; requires Pi print mode (`-p` or `--print`)
- `--schema <path>`: alias for `--final-schema`

## Environment

- `LOCALAGENT_BASE_URL`
- `LOCALAGENT_MODEL`
- `LOCALAGENT_PROVIDER_ID`
- `LOCALAGENT_STATE_DIR`
- `LOCALAGENT_SESSION_DIR`
- `LOCALAGENT_PI_CMD`
- `LOCALAGENT_THINKING`
- `LOCALAGENT_CONTEXT_WINDOW`
- `LOCALAGENT_MAX_TOKENS`
- `LOCALAGENT_TIMEOUT_MS`
- `LOCALAGENT_FINAL_SCHEMA`

## Development

```bash
npm run format
npm run lint
npm run typecheck
npm test
npm run build
npm run check
```
