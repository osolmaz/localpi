---
title: Model Catalog Implementation Plan
author: Bob <dutifulbob@gmail.com>
date: 2026-06-15
---

# Model Catalog Implementation Plan

Localpi should become a model catalog and launcher.

The goal is that plain `localpi` can show every usable local model, let the user pick one, and still give Pi enough model config for `/model` to switch among the same choices during the session.

## Target Behavior

- `localpi` discovers available local model providers before Pi starts.
- If exactly one usable model is available, localpi starts Pi with that model.
- If multiple usable models are available, localpi shows an interactive provider/model picker.
- If no external model is available, localpi can fall back to the managed `llama-server` default.
- Explicit `--provider` and `--model` flags bypass the startup picker.
- Pi receives a generated `models.json` containing every discovered usable model, not just the selected one.
- Pi receives a generated `settings.json` with the selected provider and model as the defaults.
- Pi `/model` can switch among the launch-time catalog entries without localpi-specific extension behavior.

The launch-time catalog is the first milestone. Live refresh after Pi has already started should be treated as a later Pi integration problem.

## Design Principles

- Keep model discovery, model selection, Pi config generation, and process management separate.
- Treat LM Studio, vLLM, managed `llama-server`, and future backends as provider adapters.
- Do not hide runtime side effects. Starting or stopping heavyweight model processes must be explicit or clearly prompted.
- Do not use Pi extensions to smuggle basic model inventory into Pi. Model inventory belongs in generated Pi config.
- Keep scripts deterministic. Non-interactive runs should not hang waiting for a picker.

## Catalog Model

Add a normalized catalog entry type.

```ts
type CatalogModel = {
  readonly providerId: string;
  readonly providerName: string;
  readonly runtime: "openai-compatible" | "managed-llama-server";
  readonly baseUrl: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly capabilities: readonly ModelCapability[];
  readonly availability: "loaded" | "startable";
};
```

Use the catalog entry as the only data shape passed from discovery into selection and Pi config generation.

## Provider Registry

Add a provider registry that combines built-in providers with user config.

Built-in providers:

- `lmstudio`: OpenAI-compatible, default base URL `http://127.0.0.1:1234/v1`, discovery enabled.
- `llama-server`: managed localpi runtime, exposes configured aliases as startable models.

Config-backed providers:

- vLLM and other OpenAI-compatible servers should be configured by provider id and base URL.
- Localpi should not scan random ports for vLLM.
- A provider config can opt into or out of discovery.

Example config:

```json
{
  "providers": {
    "vllm-qwen": {
      "type": "openai-compatible",
      "name": "vLLM Qwen",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "discover": true
    }
  }
}
```

## Provider Adapters

Create one adapter interface.

```ts
type ProviderAdapter = {
  readonly providerId: string;
  discover(): Promise<readonly CatalogModel[]>;
};
```

OpenAI-compatible adapter:

- Probe `<baseUrl>/models`.
- Convert every reported model id into a `CatalogModel`.
- Preserve known context-window metadata when the endpoint reports it.
- Treat connection failures as unavailable provider results, not fatal startup errors, unless the user explicitly selected that provider.

Managed `llama-server` adapter:

- Include the currently served localpi-owned model as `loaded`.
- Include configured aliases as `startable` when their GGUF path exists.
- Keep existing memory-safety rules before starting a selected startable model.

## Selection Policy

Selection should happen after catalog discovery.

Interactive terminal:

- If there is more than one usable model and no explicit model was requested, show a numbered picker.
- Display provider and model together, for example `LM Studio / qwen3.6-35b-a3b-mtp`.
- Let Enter choose the first ranked model.

Non-interactive terminal:

- Do not prompt.
- Use a deterministic default.
- If the default is ambiguous, fail with a message that lists available `--provider` and `--model` values.

Explicit flags:

- `--provider <id> --model <id>` selects an exact catalog entry.
- `--model <provider>/<model>` can be added as a shorthand once provider ids are stable.
- Existing managed llama-server aliases should continue to work.

## Pi Config Generation

Change `writeRuntimeConfig` to receive the selected model and the full catalog.

Generated `models.json` should include one provider entry per catalog provider.

Generated `settings.json` should set:

- `defaultProvider` to the selected provider id
- `defaultModel` to the selected model id
- current thinking, telemetry, startup, and compaction defaults as today

Each catalog model should become one Pi model entry with:

- `id`
- `name`
- `reasoning`
- `input`
- `contextWindow` when known
- `maxTokens`
- zero local cost

This is what lets Pi `/model` switch among all launch-time catalog models without a localpi extension.

## Runtime Start Rules

Loaded models:

- If the selected model is already loaded behind an external OpenAI-compatible endpoint, just launch Pi against it.

Startable managed models:

- If the selected model is a managed `llama-server` alias, start or reuse localpi-owned `llama-server`.
- Preserve the existing rule that localpi should not silently start another heavyweight local runtime when LM Studio already has loaded models.

External providers:

- Never start or stop LM Studio, vLLM, TGI, Ollama, or other externally managed providers unless a future adapter explicitly owns that lifecycle.

## Implementation Phases

### Phase 1: Catalog Types And Discovery

- Add catalog types.
- Add provider registry loading.
- Add OpenAI-compatible provider adapter.
- Add managed `llama-server` provider adapter.
- Unit-test discovery for loaded, unavailable, and startable models.

### Phase 2: Startup Selection

- Replace runtime-first resolution with catalog-first resolution.
- Add terminal selector for interactive runs.
- Keep deterministic non-interactive behavior.
- Preserve explicit `--runtime`, `--provider`, and `--model` compatibility.

### Phase 3: Pi Config From Catalog

- Generate `models.json` from the full catalog.
- Generate `settings.json` from the selected catalog entry.
- Update launch planning to pass the selected provider/model.
- Add tests proving Pi config contains multiple providers and models.

### Phase 4: Runtime Lifecycle Integration

- Start managed `llama-server` only when the selected catalog entry is startable.
- Keep existing localpi-owned metadata and stop/reuse behavior.
- Keep LM Studio/vLLM as externally managed.
- Add tests for memory-safety prompts and failure messages.

### Phase 5: Documentation And Migration

- Document plain `localpi` selection behavior.
- Document provider registry config.
- Document non-interactive selection rules.
- Document that Pi `/model` sees the launch-time catalog.
- Document that live model refresh is not part of the first implementation.

## Out Of Scope

- Live refresh of Pi `/model` after Pi has started.
- Starting or stopping LM Studio.
- Guessing vLLM ports.
- Global system model management.
- Cloud provider authentication.
- Classifier-specific model routing.
- Localpager-specific behavior.
