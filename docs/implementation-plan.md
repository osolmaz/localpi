# Implementation Plan

This plan tracks the migration from `localagent` to `localpi` and changes the product from a generic OpenAI-compatible wrapper into a polished local Pi launcher.

## 1. Rename The Public Surface

- [x] Rename package metadata from `@dutifuldev/localagent` to `@dutifuldev/localpi`.
- [x] Rename the installed binary from `localagent` to `localpi`.
- [x] Rename source namespaces from `localagent` to `localpi`.
- [x] Rename default state from `~/.local/state/localagent` to `~/.local/state/localpi`.
- [x] Replace `LOCALAGENT_*` environment variables with `LOCALPI_*`.
- [x] Do not keep a `localagent` compatibility shim.

## 2. Remove Structured Output

- [x] Remove `--final-schema` and `--schema` from option parsing.
- [x] Remove `LOCALAGENT_FINAL_SCHEMA`.
- [x] Delete `src/structured/final-schema.ts`.
- [x] Delete structured-output tests and example schemas.
- [x] Keep a migration note that schema-constrained classifier runs belong in `localpager-agent`.
- [x] Confirm the current localpager classifier uses `localpager-agent --final-schema`, not localpi.

Older workspace wrappers outside this repository still mention `localagent --final-schema`; those should be migrated separately if they are still used.

## 3. Add Runtime Backends

- [x] Add a runtime option with default `llama-server`.
- [x] Implement a managed `llama-server` backend:
  - [x] model alias resolution
  - [x] custom GGUF path support
  - [x] context window configuration
  - [x] chat template file support
  - [x] pid file and metadata file under localpi state
  - [x] start, reuse, status, and stop
- [x] Implement explicit `lmstudio` backend:
  - [x] default base URL `http://127.0.0.1:1234/v1`
  - [x] model probing through `/v1/models`
  - [x] clear failures when LM Studio is not running or the model is not loaded
- [x] Keep a generic `openai-compatible` backend for externally managed servers.

## 4. Add Default Pi Extensions

- [x] Add a tool approval extension.
- [x] Add a token status extension.
- [x] Generate both extensions under localpi state.
- [x] Pass them to Pi by default.
- [x] Add `--no-approval` for trusted sessions.
- [x] Add `--no-token-status` if the status UI causes problems in print or non-interactive mode.

## 5. Add Default Tooling

- [x] Default Pi tool allow list: `read,bash,edit,write,grep,find,ls`.
- [x] Allow override with `--tools`.
- [x] Preserve `--` forwarding for raw Pi flags.
- [x] Keep the system prompt short and generic.

## 6. Memory Safety

- [x] Only manage localpi-owned `llama-server` processes.
- [x] Stop the previous localpi-owned server before starting a different managed model.
- [x] In `llama-server` mode, detect loaded LM Studio models where possible and warn before starting a large model.
- [x] Never silently start both LM Studio and managed `llama-server` for the same localpi command.

## 7. Verification

- Unit-test option parsing, runtime selection, Pi launch planning, and server lifecycle decisions.
- Smoke-test:
  - `localpi --list`
  - `localpi --status`
  - `localpi --model gemma-e4b -p "say ok"`
  - `localpi --model gemma-12b`
  - `localpi --runtime lmstudio --model gemma-4-e4b-it -p "say ok"`
  - approval denial in an interactive tool call
  - token status display in an interactive session
- Run `npm run check` before merging implementation changes.
