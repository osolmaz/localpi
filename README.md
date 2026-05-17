# localagent

Localagent is a small TypeScript CLI for working with local and open-weight model workflows.

It currently does two things:

- runs prompts against an OpenAI-compatible local model server such as LM Studio
- searches a local gitcrawl SQLite database with a weighted local-model taxonomy

## Install

```bash
npm install
npm run build
```

During development, run the CLI through npm:

```bash
npm run localagent -- --help
```

After a build, the package binary is:

```bash
node dist/src/cli/main.js --help
```

## LM Studio / Gemma

Start the LM Studio local server and load Gemma:

```bash
~/.lmstudio/bin/lms server start
~/.lmstudio/bin/lms load gemma-4-e4b-it --identifier gemma-local -y
```

Check the model endpoint:

```bash
npm run localagent -- models --base-url http://127.0.0.1:1234/v1
```

Generate a longer response:

```bash
npm run localagent -- run \
  --base-url http://127.0.0.1:1234/v1 \
  --model gemma-local \
  --max-tokens 1800 \
  --prompt-file examples/prompts/gemma-longform.md
```

Use `--model auto` to select the first model returned by `/v1/models`.

## Gitcrawl Search

```bash
npm run localagent -- search-gitcrawl \
  --db ~/.config/gitcrawl/gitcrawl.db \
  --repo openclaw/openclaw \
  --kind issue \
  --state open \
  --min-score 14 \
  --limit 20
```

Machine-readable output:

```bash
npm run localagent -- search-gitcrawl --format jsonl
```

The taxonomy lives at `data/local-model-keywords.json`. Scores are a recall signal, not a final classifier.

## Project Commands

```bash
npm run format
npm run lint
npm run typecheck
npm test
npm run build
npm run check
```
