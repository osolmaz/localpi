# AGENTS.md - localagent

This repository is a TypeScript CLI for local model workflows.

Before finishing code changes, run:

```bash
npm run check
```

Rules:

- Keep TypeScript strict. Do not use `any`; validate unknown JSON at the boundary.
- Keep network, filesystem, process, and SQLite CLI calls outside pure scoring/parsing code.
- Add or update tests for behavior changes.
- Do not commit generated output, local model responses, secrets, or downloaded model files.
- Follow the Slophammer agent entrypoint in `dutifuldev/slophammer/docs/AGENT_ENTRYPOINT.md` when changing repo structure or quality gates.
