# localagent

Small local-agent utilities for finding OpenClaw work related to local and open-weight models.

The first tool searches a local gitcrawl SQLite database with a machine-readable keyword taxonomy.

## Files

- `data/local-model-keywords.json` - weighted keyword and regex groups for local-model signals
- `scripts/search_gitcrawl.py` - searches gitcrawl issue/PR documents and returns scored matches

## Usage

```bash
python3 scripts/search_gitcrawl.py \
  --db ~/.config/gitcrawl/gitcrawl.db \
  --repo openclaw/openclaw \
  --kind issue \
  --state open \
  --min-score 14 \
  --limit 20
```

Machine-readable output:

```bash
python3 scripts/search_gitcrawl.py --format jsonl
```

## Scoring

Each matched keyword group adds its configured weight. Regex groups are scored the same way. The score is meant as a recall and triage aid, not a final classifier. Human maintainer policy should still decide whether an item is actually important.
