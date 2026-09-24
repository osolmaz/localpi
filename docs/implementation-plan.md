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

## 8. ACP Mode

- [x] Add `--acp` and `LOCALPI_ACP=1`, and keep a normal launch as the default.
- [x] Pin `pi-acp` in `package.json` and the lockfile. Do not vendor its source.
- [x] Keep the ACP start in its own module next to the existing launcher.
- [x] Resolve the model and write the Pi configuration a normal launch writes, then start the adapter with inherited stdio.
- [x] Point `PI_ACP_PI_COMMAND` at a generated launcher script that execs Pi with the complete launch line of a normal launch, and pass the environment a normal launch uses.
- [x] Require an explicit model from the flag, environment, or model profile, and fail with one clear message instead of printing a picker.
- [x] Keep stdout for protocol bytes only, and send diagnostics, warnings, and startup notes to stderr.
- [x] Refuse a Pi command that is localpi itself, and set `LOCALPI_ACP=0` for the child, so a spawned child cannot re-enter ACP mode.
- [x] Unit-test the command and environment, stdout purity, the missing-model failure, exit-code propagation, and the absence of ACP re-entry, with a fake adapter child.
- [x] Document ACP mode in the README and in `docs/runtime-specification.md`.
- [x] Keep `npm run check` green, and leave the thinking budget and model profile semantics unchanged.

## 9. Continue On Truncation

- [ ] Add `--continue-on-truncation <n>` and `LOCALPI_CONTINUE_ON_TRUNCATION=<n>`, where `n` is a positive integer and is the maximum number of extra continuations.
- [ ] Keep the feature off by default, so a normal launch, an ACP launch, and demo mode behave exactly as they do today with no flag and no environment variable.
- [ ] Treat `0` from the environment as off, so an inherited value can be disabled without dropping the variable.
- [ ] Keep the usual precedence, command-line flag, environment variable, then default, and add the usage line.
- [ ] Fail an invalid value with one clear message and exit code 2.
- [ ] Add the generated extension source `src/pi/extension-sources/continue-on-truncation.ts`, and bake the continuation limit into the generated source.
- [ ] Include the extension in the bundle only when the feature is enabled, and change nothing in the bundle otherwise.
- [ ] Detect the length stop on the turn-end hook, and continue only for that reason.
- [ ] Send exactly one follow-up user message that tells the model to continue where it stopped and not to repeat earlier text.
- [ ] Count continuations per session, and stop after the limit, so the feature cannot loop forever.
- [ ] Never continue a turn that ended for another reason, including a normal stop, a tool-only turn, an error stop, and a user cancellation.
- [ ] Write diagnostics to stderr only, and keep stdout free for protocol bytes and batch output.
- [ ] Unit-test option parsing and validation, the bundle containing the guard only when it is enabled, one continuation message on a truncated turn, the count stopping at the limit, and no continuation on a normal turn.
- [ ] Document the feature in the README and in `docs/runtime-specification.md`.
- [ ] Keep `npm run check` green, and leave the thinking budget, the model profile limits, and the ACP contract unchanged.
