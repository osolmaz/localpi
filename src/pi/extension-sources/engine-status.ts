import type { EngineEntry } from "../../localpi/provider-registry.js";

export type EngineStatusConfig = {
  readonly engines: readonly EngineEntry[];
};

/**
 * Show the inference engine that serves the current model in Pi's footer status line. localpi knows
 * the engine for its built-in providers, so the label is read from the launch-time map instead of
 * being guessed from the model name. A model from an unknown provider clears the label.
 */
export function engineStatusExtensionSource(config: EngineStatusConfig): string {
  const enginesSource = JSON.stringify(config.engines);
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type EngineEntry = {
  readonly provider: string;
  readonly engine: string;
};

type EngineContext = {
  readonly ui: {
    setStatus(key: string, text: string | undefined): void;
  };
};

const engines: readonly EngineEntry[] = ${enginesSource};
const statusKey = "localpi-engine";

export default function localpiEngineStatus(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    showEngine(ctx, ctx.model);
  });

  pi.on("model_select", (event, ctx) => {
    showEngine(ctx, event.model);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(statusKey, undefined);
  });
}

function showEngine(ctx: EngineContext, model: { readonly provider?: string } | undefined): void {
  const provider = model?.provider;
  const entry = engines.find((candidate) => candidate.provider === provider);
  ctx.ui.setStatus(statusKey, entry?.engine);
}
`;
}
