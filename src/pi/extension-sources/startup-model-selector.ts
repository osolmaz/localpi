import type { StartupModelSelectorOptions } from "../extensions.js";

export function startupModelSelectorExtensionSource(options: StartupModelSelectorOptions): string {
  const startupModelsSource = JSON.stringify(options.models);
  return `import type { ExtensionAPI, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";

type SelectedModel = Parameters<ExtensionAPI["setModel"]>[0];
const startupModels = ${startupModelsSource} as const;
const startupModelKeys = new Set(startupModels.map((model) => modelKey(model)));

export default function localpiStartupModelSelector(pi: ExtensionAPI): void {
  let opened = false;

  pi.on("session_start", async (event, ctx) => {
    if (opened || event.reason !== "startup" || ctx.mode !== "tui") {
      return;
    }

    const selectableModels = startupAvailableModels(ctx.modelRegistry);
    if (selectableModels.length <= 1) {
      return;
    }
    const scopedModels = selectableModels.map((model) => ({ model }));

    opened = true;
    const selected = await ctx.ui.custom<SelectedModel | undefined>((tui, _theme, _keybindings, done) =>
      new ModelSelectorComponent(
        tui,
        ctx.model,
        startupModelRuntime(ctx.modelRegistry),
        scopedModels,
        (model: SelectedModel) => done(model),
        () => done(undefined)
      )
    );

    if (selected === undefined) {
      return;
    }

    const ok = await pi.setModel(selected);
    if (!ok) {
      ctx.ui.notify(\`No API key for \${selected.provider}/\${selected.id}\`, "error");
    }
  });
}

function startupAvailableModels(registry: {
  getAvailable(): SelectedModel[];
}): SelectedModel[] {
  return registry.getAvailable().filter((model) => startupModelKeys.has(modelKey(model)));
}

// The selector reads a ModelRuntime, which extensions cannot reach. It only calls
// getAvailableSnapshot, getModel, getError, and refresh, so this view answers
// those from the registry and hides every model outside the startup list.
function startupModelRuntime(registry: ModelRegistry): ModelRuntime {
  const view = {
    getAvailableSnapshot: () => startupAvailableModels(registry),
    getModel: (provider: string, modelId: string) => {
      const model = registry.find(provider, modelId);
      return model !== undefined && startupModelKeys.has(modelKey(model)) ? model : undefined;
    },
    getError: () => registry.getError(),
    refresh: (options?: Parameters<ModelRegistry["refresh"]>[0]) => registry.refresh(options)
  };
  return view as unknown as ModelRuntime;
}

function modelKey(model: { readonly provider: string; readonly id: string }): string {
  return \`\${model.provider}\\u0000\${model.id}\`;
}
`;
}
