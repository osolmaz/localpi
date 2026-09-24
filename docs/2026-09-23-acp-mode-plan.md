# Plan: ACP mode for localpi

Date: 2026-09-23
Status: selected for implementation

## Goal

Make localpi able to act as an ACP agent. Add `localpi --acp` (and
`LOCALPI_ACP=1`) that resolves and writes the same Pi configuration a normal
launch writes, then starts the ACP server on stdio and gets out of the way. Pin
`pi-acp` as a dependency instead of vendoring its source.

## Why

`pi-acp` is the maintained ACP adapter for Pi (owner `svkozak`, MIT, npm
`pi-acp@0.0.33`, published with provenance). localpi already owns model
resolution, Pi configuration, and launching. Adding ACP on top of that turns
localpi into an agent that ACP clients can drive, including the Harbor harness,
so a benchmark can measure this launcher instead of a purpose-built adapter.

## Verified facts

These were read from the pinned sources, not assumed.

- `pi-acp` spawns Pi as `pi --mode rpc --no-themes`, plus `--session <path>`
  when a session path exists, and passes the current environment to the child.
- `pi-acp` uses `PI_ACP_PI_COMMAND` as the executable name, so localpi can point
  it at the Pi it resolved.
- `pi-acp` reads settings from `$PI_CODING_AGENT_DIR/settings.json` and from
  `<cwd>/.pi/settings.json`, and it does not pass `--no-extensions`, so Pi
  extension discovery stays enabled.
- localpi is at version 0.5.2, is a strict TypeScript CLI, and declares
  `@osolmaz/pi-factory` and `pi-demo-mode` as its only dependencies. Its bin is
  `localpi` mapped to `dist/src/cli/main.js`.
- localpi has no ACP support today. A search for ACP over its source, docs,
  README, and manifest returns only `llamaCpp` substrings.
- localpi already forwards `--mode` to Pi and only rejects it together with
  `--demo`.
- Pi has no ACP mode of its own, so the ACP server must be a separate process.

## Design

1. Pin, do not vendor. Add `pi-acp` to `dependencies` at a fixed version with a
   lockfile entry. Do not copy its source into this repository.
2. One new entry path. `localpi --acp` and `LOCALPI_ACP=1` start the ACP server.
   Follow the existing precedence: flag, environment, saved setting, default.
   The default stays a normal launch, so nothing changes for current users.
3. Configure first, then hand off. Run the existing resolution and Pi config
   writing, then start the pinned `pi-acp` with inherited stdio. Reuse the
   existing resolution path. Do not duplicate discovery or config writing.
4. No interactive selection in ACP mode. There is no TTY, so require an explicit
   model from the flag, environment, or model profile, and fail with a clear
   message when none is given. Never print a picker.
5. Keep stdout pure. In ACP mode, stdout carries protocol bytes only. Send
   diagnostics, warnings, and startup notes to stderr. Add a test that fails if
   anything else reaches stdout.
6. Point the adapter at the resolved Pi. Set `PI_ACP_PI_COMMAND` to the Pi
   executable localpi would launch, and pass the same environment the normal
   launch uses: the Pi config directory, provider base URL, the API key name,
   the thinking level, and the session directory.
7. Do not select ACP again inside the child. The ACP path must set the adapter
   command to Pi itself, never back to localpi, so a spawned child cannot
   re-enter ACP mode. Add a test for that.
8. Keep the existing rules. Settings stay in `<state-dir>/settings.json`. Model
   profile limits (`client.context_window`, `client.max_tokens`) and the managed
   llama-server thinking budget keep their current meaning. Never invent a
   smaller reply cap than the declared one.

## Deliverables

- `localpi --acp` and `LOCALPI_ACP=1`, implemented in the existing launcher
  structure with the ACP start kept in its own module.
- `pi-acp` pinned in `package.json` and the lockfile.
- Unit tests with a fake ACP child: correct command and environment, pure
  stdout, a clear failure when no explicit model is given, exit-code
  propagation, and no re-entry into ACP mode.
- A README section for ACP mode and an entry in
  `docs/runtime-specification.md`.

## Acceptance checks

1. `npm run check` passes, including the generated-extension typecheck test.
2. `localpi --acp` with a fake adapter child starts it with the expected
   environment, and stdout carries only protocol bytes.
3. `localpi --acp` without an explicit model fails fast with one clear message
   and no picker.
4. A normal launch, without the ACP flag, behaves exactly as before.
5. No new state file appears; every new setting lives in the settings object.

## Out of scope

- Harbor manifests, harness wheels, and benchmark arms. Those belong to
  `osolmaz/harbor-custom-harnesses`.
- Vendoring `pi-acp` source, or building anything from source.
- Publishing to npm, merging, or any release. Those need a separate instruction.
- Real model inference in tests.

## Authority

- Repository: `osolmaz/localpi` only.
- Allowed: edit, test, commit, push, open a pull request.
- Not allowed: merge without an explicit instruction, publish a package or a
  release, install or copy credentials, run paid remote work, or push to another
  repository.

## Risks

- Two Pi processes could blink in and out if the adapter command ever points
  back at localpi. The re-entry test covers this.
- Any startup chatter on stdout breaks the protocol handshake, so the purity
  test is part of the gate, not an afterthought.
