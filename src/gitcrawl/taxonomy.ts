import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { asArray, asObject, optionalString } from "../common/json.js";

export type WeightedGroup = {
  readonly id: string;
  readonly weight: number;
  readonly terms: readonly string[];
};

export type Taxonomy = {
  readonly keywordGroups: readonly WeightedGroup[];
  readonly regexGroups: readonly WeightedGroup[];
};

export type Match = {
  readonly group: string;
  readonly weight: number;
  readonly terms: readonly string[];
};

export type ScoredDocument = {
  readonly score: number;
  readonly matches: readonly Match[];
};

export function defaultTaxonomyPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../data/local-model-keywords.json"),
    path.resolve(here, "../../data/local-model-keywords.json")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? "";
}

export async function loadTaxonomy(filePath = defaultTaxonomyPath()): Promise<Taxonomy> {
  const payload: unknown = JSON.parse(await readFile(filePath, "utf8"));
  const root = asObject(payload, "taxonomy");
  return {
    keywordGroups: parseGroups(root["keywordGroups"], "keywordGroups", "keywords"),
    regexGroups: parseGroups(root["regexGroups"], "regexGroups", "patterns")
  };
}

export function scoreDocument(text: string, taxonomy: Taxonomy): ScoredDocument {
  const folded = text.toLocaleLowerCase();
  const matches = [
    ...taxonomy.keywordGroups.flatMap((group) => keywordMatch(folded, group)),
    ...taxonomy.regexGroups.flatMap((group) => regexMatch(text, group))
  ];
  return {
    score: matches.reduce((sum, match) => sum + match.weight, 0),
    matches
  };
}

function keywordMatch(foldedText: string, group: WeightedGroup): readonly Match[] {
  const terms = group.terms.filter((term) => foldedText.includes(term.toLocaleLowerCase()));
  return terms.length === 0 ? [] : [{ group: group.id, weight: group.weight, terms }];
}

function regexMatch(text: string, group: WeightedGroup): readonly Match[] {
  const terms = group.terms.filter((pattern) => new RegExp(pattern, "iu").test(text));
  return terms.length === 0 ? [] : [{ group: group.id, weight: group.weight, terms }];
}

function parseGroups(value: unknown, context: string, termsKey: string): readonly WeightedGroup[] {
  return asArray(value, context).map((entry, index) => {
    const indexText = String(index);
    const group = asObject(entry, `${context}[${indexText}]`);
    return {
      id: optionalString(group["id"]) ?? `${context}-${indexText}`,
      weight: parseWeight(group["weight"], `${context}[${indexText}].weight`),
      terms: asArray(group[termsKey], `${context}[${indexText}].${termsKey}`).map(
        (term, termIndex) =>
          parseTerm(term, `${context}[${indexText}].${termsKey}[${String(termIndex)}]`)
      )
    };
  });
}

function parseWeight(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number`);
  }
  return value;
}

function parseTerm(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}
