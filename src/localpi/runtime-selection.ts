import type { CatalogModel, CatalogWarning, ModelCatalog } from "./catalog.js";
import { customPathCatalogModel } from "./managed-runtime.js";
import { defaultLlamaModelName } from "./models.js";
import type { LocalpiOptions } from "./options.js";
import { modelChoiceList } from "./runtime-connection.js";

export async function selectCatalogModel(
  options: LocalpiOptions,
  catalog: ModelCatalog
): Promise<CatalogModel> {
  const selection = normalizedSelection(options, catalog.models);
  const providerFiltered = modelsForProvider(catalog.models, selection.provider);
  if (providerFiltered.length === 0) {
    const customPath = await customPathCatalogModel(options, selection.provider, selection.model);
    if (customPath !== undefined) {
      return customPath;
    }
    if (selection.provider !== undefined) {
      throw new Error(`provider ${selection.provider} did not report usable models`);
    }
  }
  if (selection.model !== "auto") {
    return selectExplicitCatalogModel(
      options,
      providerFiltered,
      selection.provider,
      selection.model
    );
  }
  return selectAutomaticCatalogModel(
    providerFiltered,
    warningsForProvider(catalog.warnings, selection.provider)
  );
}

async function selectExplicitCatalogModel(
  options: LocalpiOptions,
  models: readonly CatalogModel[],
  provider: string | undefined,
  requested: string
): Promise<CatalogModel> {
  const matches = matchingCatalogModels(models, requested);
  const [onlyMatch] = matches;
  if (onlyMatch !== undefined && matches.length === 1) {
    return onlyMatch;
  }
  if (matches.length > 1) {
    throw new Error(
      `model ${requested} is available from multiple providers; choose one with --provider:\n${modelChoiceList(matches)}`
    );
  }
  const customPath = await customPathCatalogModel(options, provider, requested);
  if (customPath !== undefined) {
    return customPath;
  }
  throw new Error(`model ${requested} is not available; choices:\n${modelChoiceList(models)}`);
}

function selectAutomaticCatalogModel(
  models: readonly CatalogModel[],
  warnings: readonly CatalogWarning[]
): CatalogModel {
  const loaded = models.filter((model) => model.availability === "loaded");
  const [onlyLoaded] = loaded;
  if (onlyLoaded !== undefined) {
    return onlyLoaded;
  }
  const fallback = startableFallback(models, warnings);
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(noLoadedModelsMessage(models, warnings));
}

function modelsForProvider(
  models: readonly CatalogModel[],
  provider: string | undefined
): readonly CatalogModel[] {
  return provider === undefined ? models : models.filter((model) => model.providerId === provider);
}

function normalizedSelection(
  options: LocalpiOptions,
  models: readonly CatalogModel[]
): { readonly provider: string | undefined; readonly model: string } {
  const requested = options.model ?? "auto";
  if (options.provider !== undefined || requested === "auto" || isGgufFilePathRequest(requested)) {
    return { provider: options.provider, model: requested };
  }
  const separator = requested.indexOf("/");
  if (separator <= 0) {
    return { provider: options.provider, model: requested };
  }
  const provider = requested.slice(0, separator);
  if (!models.some((model) => model.providerId === provider)) {
    return { provider: options.provider, model: requested };
  }
  return { provider, model: requested.slice(separator + 1) };
}

function matchingCatalogModels(
  models: readonly CatalogModel[],
  requested: string
): readonly CatalogModel[] {
  return models.filter((model) => model.modelId === requested || model.aliases.includes(requested));
}

function isGgufFilePathRequest(value: string): boolean {
  return value.toLowerCase().endsWith(".gguf") || value.includes("\\");
}

function startableFallback(
  models: readonly CatalogModel[],
  warnings: readonly CatalogWarning[]
): CatalogModel | undefined {
  const startable = models.filter(
    (model) =>
      model.availability === "startable" &&
      (model.runtime !== "managed-llama-server" || managedLlamaFallbackAvailable(warnings))
  );
  return (
    startable.find(
      (model) =>
        model.aliases.includes(defaultLlamaModelName()) || model.modelId === defaultLlamaModelName()
    ) ?? startable[0]
  );
}

function managedLlamaFallbackAvailable(warnings: readonly CatalogWarning[]): boolean {
  return !warnings.some(
    (warning) =>
      warning.providerId === "llama-server" && warning.code === "managed-command-unavailable"
  );
}

function noLoadedModelsMessage(
  models: readonly CatalogModel[],
  warnings: readonly CatalogWarning[]
): string {
  const sections = engineSections(models, warnings);
  if (sections.length === 0) {
    return "no loaded models available\n\nTried engines:\n\n- none reported usable models";
  }
  return [
    "no loaded models available",
    "",
    "Tried engines:",
    "",
    sections.map(formatEngineSection).join("\n\n")
  ].join("\n");
}

type EngineSection = {
  readonly title: string;
  readonly loaded: readonly string[];
  readonly startable: readonly string[];
  readonly warnings: readonly string[];
};

function engineSections(
  models: readonly CatalogModel[],
  warnings: readonly CatalogWarning[]
): readonly EngineSection[] {
  const sections = new Map<string, EngineSection>();
  for (const model of models) {
    const section = ensureEngineSection(sections, model.providerId, model.providerName);
    const entry = `${model.providerId}/${model.modelId}`;
    const updated =
      model.availability === "loaded"
        ? { ...section, loaded: [...section.loaded, entry] }
        : { ...section, startable: [...section.startable, entry] };
    sections.set(model.providerId, updated);
  }
  for (const warning of warnings) {
    const section = ensureEngineSection(sections, warning.providerId, warning.providerName);
    sections.set(warning.providerId, {
      ...section,
      warnings: [...section.warnings, warning.message]
    });
  }
  return [...sections.values()];
}

function ensureEngineSection(
  sections: Map<string, EngineSection>,
  key: string,
  title: string
): EngineSection {
  const existing = sections.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const section: EngineSection = { title, loaded: [], startable: [], warnings: [] };
  sections.set(key, section);
  return section;
}

function formatEngineSection(section: EngineSection): string {
  const lines = [`${section.title}:`];
  if (section.loaded.length === 0) {
    lines.push("- loaded models: none");
  } else {
    lines.push(`- loaded models: ${section.loaded.join(", ")}`);
  }
  if (section.startable.length > 0) {
    lines.push(`- startable models: ${section.startable.join(", ")}`);
  }
  for (const warning of section.warnings) {
    lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}

function warningsForProvider(
  warnings: readonly CatalogWarning[],
  provider: string | undefined
): readonly CatalogWarning[] {
  return provider === undefined
    ? warnings
    : warnings.filter((warning) => warning.providerId === provider);
}
