# AGENTS.md - localpi

This repository is a TypeScript CLI that runs Pi against local inference engines.

Before finishing code changes, run:

```bash
npm run check
```

Rules:

- Keep TypeScript strict. Do not use `any`; validate unknown JSON at the boundary.
- Keep local model discovery, Pi config generation, and process launching in separate modules.
- Add or update tests for behavior changes.
- Keep classifier-specific and final-schema workflows out of this repo. Those belong in callers such as localpager-agent.
- Do not commit generated output, local model responses, secrets, session files, or downloaded model files.
- Store persistent localpi user settings in `<state-dir>/settings.json`. Do not create a new top-level state file for each setting; add a field to the settings object instead. Separate files are only for distinct generated artifacts, runtime metadata, caches, logs, or external config formats.
- Follow the Slophammer agent entrypoint in `osolmaz/slophammer/docs/AGENT_ENTRYPOINT.md` when changing repo structure or quality gates.

## Pi TUI Integration

localpi is a launcher and integration layer for Pi. It must not replace, bypass, or reimplement Pi's native TUI for interactive user workflows.

When a feature affects the interactive experience, implement it by extending or configuring Pi's own TUI:

- Prefer Pi extensions, Pi config files, Pi provider/model registry entries, and Pi-native UI components.
- Launch the normal Pi TUI for interactive modes and let Pi own rendering, input handling, streaming, session state, slash commands, and lifecycle.
- Do not create a parallel readline prompt, custom selector, separate terminal UI, or headless loop when the user expectation is to be inside Pi.
- Do not force print mode, JSON mode, RPC mode, or repeated one-shot Pi processes for a feature that should be visible in the live TUI.
- Only use non-interactive Pi launches for explicitly non-interactive commands, tests, status/list/stop commands, or scripted smoke checks.

Concrete examples:

- Model selection at startup should use Pi's native model selector through an extension, scoped to the models localpi discovered. It should not use a localpi-owned dropdown, readline prompt, or preselect a model behind the user's back.
- `/model` behavior should remain Pi's native model-selection flow, with localpi contributing provider/model config so the right local models appear there.
- Demo mode should launch the normal Pi TUI once and drive prompts through a Pi extension, for example by sending the initial prompt on `session_start` and followup prompts after `turn_end`. It should not run a hidden loop of separate print-mode Pi processes.
- Thinking controls should extend Pi's slash-command or settings behavior. They should not introduce a separate localpi control surface that conflicts with Pi's TUI.
