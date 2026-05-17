import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { asArray, asObject, optionalString } from "../common/json.js";
import { loadTaxonomy, scoreDocument, type Match, type Taxonomy } from "./taxonomy.js";

const execFileAsync = promisify(execFile);

export type SearchOptions = {
  readonly dbPath: string;
  readonly taxonomyPath?: string;
  readonly repo: string;
  readonly kind: "issue" | "pull_request" | "all";
  readonly state: "open" | "closed" | "all";
  readonly minScore: number;
  readonly limit: number;
};

export type SearchResult = {
  readonly number: number;
  readonly kind: string;
  readonly state: string;
  readonly title: string;
  readonly url: string;
  readonly score: number;
  readonly matches: readonly Match[];
};

type ThreadRow = {
  readonly number: number;
  readonly kind: string;
  readonly state: string;
  readonly title: string;
  readonly body: string;
  readonly rawText: string;
  readonly url: string;
  readonly labelsJson: string;
};

export async function searchGitcrawl(options: SearchOptions): Promise<readonly SearchResult[]> {
  const taxonomy = await loadTaxonomy(options.taxonomyPath);
  const rows = await queryGitcrawl(options);
  return rows
    .map((row) => scoreRow(row, taxonomy))
    .filter((result): result is SearchResult => result !== undefined)
    .filter((result) => result.score >= options.minScore)
    .sort((left, right) => right.score - left.score || left.number - right.number)
    .slice(0, options.limit);
}

function scoreRow(row: ThreadRow, taxonomy: Taxonomy): SearchResult | undefined {
  const labels = parseLabels(row.labelsJson).join(" ");
  const scored = scoreDocument([row.title, row.body, row.rawText, labels].join("\n"), taxonomy);
  if (scored.score === 0) {
    return undefined;
  }
  return {
    number: row.number,
    kind: row.kind,
    state: row.state,
    title: row.title,
    url: row.url,
    score: scored.score,
    matches: scored.matches
  };
}

async function queryGitcrawl(options: SearchOptions): Promise<readonly ThreadRow[]> {
  const { stdout } = await execFileAsync(
    "sqlite3",
    ["-json", options.dbPath, buildQuery(options)],
    {
      maxBuffer: 64 * 1024 * 1024
    }
  );
  const payload: unknown = stdout.trim() === "" ? [] : JSON.parse(stdout);
  return asArray(payload, "sqlite rows").map(parseThreadRow);
}

function buildQuery(options: SearchOptions): string {
  const clauses = [`r.full_name = ${sqlString(options.repo)}`];
  if (options.kind !== "all") {
    clauses.push(`t.kind = ${sqlString(options.kind)}`);
  }
  if (options.state !== "all") {
    clauses.push(`t.state = ${sqlString(options.state)}`);
  }
  return `
    select
      t.number as number,
      t.kind as kind,
      t.state as state,
      t.title as title,
      coalesce(t.body, '') as body,
      t.html_url as url,
      t.labels_json as labelsJson,
      d.raw_text as rawText
    from threads t
    join repositories r on r.id = t.repo_id
    join documents d on d.thread_id = t.id
    where ${clauses.join(" and ")}
  `;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseThreadRow(value: unknown): ThreadRow {
  const row = asObject(value, "thread row");
  return {
    number: parseNumber(row["number"], "thread number"),
    kind: optionalString(row["kind"]) ?? "",
    state: optionalString(row["state"]) ?? "",
    title: optionalString(row["title"]) ?? "",
    body: optionalString(row["body"]) ?? "",
    rawText: optionalString(row["rawText"]) ?? "",
    url: optionalString(row["url"]) ?? "",
    labelsJson: optionalString(row["labelsJson"]) ?? "[]"
  };
}

function parseNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${context} must be an integer`);
  }
  return value;
}

function parseLabels(labelsJson: string): readonly string[] {
  const parsed: unknown = JSON.parse(labelsJson);
  return asArray(parsed, "labels").flatMap((label) => {
    if (typeof label === "string") {
      return [label];
    }
    const record = asObject(label, "label");
    const name = optionalString(record["name"]);
    return name === undefined ? [] : [name];
  });
}
