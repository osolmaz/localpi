# AGENTS.md - localagent

This repository is a TypeScript CLI that runs Pi against a local OpenAI-compatible model.

Before finishing code changes, run:

```bash
npm run check
```

Rules:

- Keep TypeScript strict. Do not use `any`; validate unknown JSON at the boundary.
- Keep local model discovery, Pi config generation, and process launching in separate modules.
- Add or update tests for behavior changes.
- Do not commit generated output, local model responses, secrets, session files, or downloaded model files.
- Follow the Slophammer agent entrypoint in `dutifuldev/slophammer/docs/AGENT_ENTRYPOINT.md` when changing repo structure or quality gates.
