#!/usr/bin/env python3
"""Search a gitcrawl SQLite database with weighted keyword groups."""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_KEYWORDS = ROOT / "data" / "local-model-keywords.json"


@dataclass(frozen=True)
class Match:
    group_id: str
    weight: int
    terms: tuple[str, ...]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="~/.config/gitcrawl/gitcrawl.db", help="gitcrawl SQLite database path")
    parser.add_argument("--keywords", default=str(DEFAULT_KEYWORDS), help="keyword taxonomy JSON path")
    parser.add_argument("--repo", default="openclaw/openclaw", help="repository full name")
    parser.add_argument("--kind", choices=("issue", "pull_request", "all"), default="all")
    parser.add_argument("--state", choices=("open", "closed", "all"), default="open")
    parser.add_argument("--min-score", type=int, default=14)
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--format", choices=("markdown", "jsonl", "json"), default="markdown")
    return parser.parse_args()


def load_json(path: str | Path) -> dict:
    with Path(path).expanduser().open("r", encoding="utf-8") as handle:
        return json.load(handle)


def normalize(value: str) -> str:
    return value.casefold()


def group_matches(text: str, group: dict) -> Match | None:
    hits = tuple(keyword for keyword in group["keywords"] if normalize(keyword) in text)
    if not hits:
        return None
    return Match(group_id=group["id"], weight=int(group["weight"]), terms=hits)


def regex_matches(text: str, group: dict) -> Match | None:
    hits: list[str] = []
    for pattern in group["patterns"]:
        if re.search(pattern, text, flags=re.IGNORECASE):
            hits.append(pattern)
    if not hits:
        return None
    return Match(group_id=group["id"], weight=int(group["weight"]), terms=tuple(hits))


def score_text(text: str, taxonomy: dict) -> tuple[int, list[Match]]:
    normalized_text = normalize(text)
    matches: list[Match] = []

    for group in taxonomy.get("keywordGroups", []):
        match = group_matches(normalized_text, group)
        if match:
            matches.append(match)

    for group in taxonomy.get("regexGroups", []):
        match = regex_matches(text, group)
        if match:
            matches.append(match)

    return sum(match.weight for match in matches), matches


def iter_threads(conn: sqlite3.Connection, repo: str, kind: str, state: str) -> Iterable[sqlite3.Row]:
    clauses = ["r.full_name = ?"]
    params: list[str] = [repo]
    if kind != "all":
        clauses.append("t.kind = ?")
        params.append(kind)
    if state != "all":
        clauses.append("t.state = ?")
        params.append(state)

    query = f"""
        select
            t.number,
            t.kind,
            t.state,
            t.title,
            coalesce(t.body, '') as body,
            t.html_url,
            t.labels_json,
            d.raw_text
        from threads t
        join repositories r on r.id = t.repo_id
        join documents d on d.thread_id = t.id
        where {" and ".join(clauses)}
    """
    yield from conn.execute(query, params)


def result_for(row: sqlite3.Row, taxonomy: dict) -> dict | None:
    labels = json.loads(row["labels_json"] or "[]")
    haystack = "\n".join(
        [
            row["title"] or "",
            row["body"] or "",
            row["raw_text"] or "",
            " ".join(label.get("name", "") if isinstance(label, dict) else str(label) for label in labels),
        ]
    )
    score, matches = score_text(haystack, taxonomy)
    if score == 0:
        return None
    return {
        "number": row["number"],
        "kind": row["kind"],
        "state": row["state"],
        "title": row["title"],
        "url": row["html_url"],
        "score": score,
        "matches": [
            {"group": match.group_id, "weight": match.weight, "terms": list(match.terms[:8])}
            for match in matches
        ],
    }


def print_markdown(results: list[dict]) -> None:
    for item in results:
        print(f"- #{item['number']} [{item['kind']}] score={item['score']} {item['title']}")
        print(f"  {item['url']}")
        groups = ", ".join(match["group"] for match in item["matches"])
        print(f"  groups: {groups}")


def main() -> int:
    args = parse_args()
    taxonomy = load_json(args.keywords)
    db_path = Path(args.db).expanduser()

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        results = [
            result
            for row in iter_threads(conn, repo=args.repo, kind=args.kind, state=args.state)
            if (result := result_for(row, taxonomy)) and result["score"] >= args.min_score
        ]
    finally:
        conn.close()

    results.sort(key=lambda item: (-item["score"], item["kind"], item["number"]))
    results = results[: args.limit]

    if args.format == "json":
        print(json.dumps(results, indent=2, ensure_ascii=False))
    elif args.format == "jsonl":
        for item in results:
            print(json.dumps(item, ensure_ascii=False))
    else:
        print_markdown(results)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
