import type { EngineEntry } from "../../localpi/provider-registry.js";

export type StopThinkingConfig = {
  // The key that stops the thinking phase, or undefined when the user turned the key off.
  readonly key: string | undefined;
  readonly engines: readonly EngineEntry[];
};

// llama.cpp closes the thinking phase itself when a request continues a final assistant message
// as content. These engine labels come from the launch-time provider map, never from a model name.
const nativeEngines = new Set(["llama.cpp", "llama-server"]);
// vLLM reads chat_template_kwargs, so it can at least skip thinking for the answer.
const templateKwargsEngines = new Set(["vLLM"]);

/**
 * Stop a local model's thinking phase and ask for the answer now.
 *
 * The user presses the key, clicks the button, or runs /stop-thinking while the assistant message
 * is still thinking. The extension aborts that request and starts one new turn. For llama.cpp it
 * rewrites the new request so the server continues the partial thinking as content: the server
 * then writes the model's own end-of-thinking marker, so localpi never hard-codes `</think>`.
 */
export function stopThinkingExtensionSource(config: StopThinkingConfig): string {
  const nativeProviders = providersFor(config.engines, nativeEngines);
  const templateKwargsProviders = providersFor(config.engines, templateKwargsEngines);
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];

const shortcut: ShortcutKey | undefined = ${config.key === undefined ? "undefined" : JSON.stringify(config.key)};
const nativeProviders = new Set<string>(${JSON.stringify(nativeProviders)});
const templateKwargsProviders = new Set<string>(${JSON.stringify(templateKwargsProviders)});

const customType = "localpi-stop-thinking";
const widgetKey = "localpi-stop-thinking";
const instruction = "Stop thinking now. Give your answer based on the reasoning you have so far.";
const buttonLabel = "[ Stop thinking and answer ]";

type ContentBlock = {
  readonly type?: string;
  readonly text?: string;
  readonly thinking?: string;
};

type MessageLike = {
  readonly role?: string;
  readonly stopReason?: string;
  readonly content?: unknown;
};

type ThemeLike = {
  fg(color: string, text: string): string;
};

type StopContext = {
  readonly mode?: string;
  readonly hasUI?: boolean;
  readonly model?: { readonly provider?: string } | undefined;
  abort(): void;
  readonly ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setWidget(key: string, content: unknown): void;
  };
};

type MouseEventLike = {
  readonly type: string;
  readonly button: string;
  readonly x: number;
};

type StopRequest = {
  readonly provider: string;
  thinking: string;
};

type PayloadMessage = Record<string, unknown>;

export default function localpiStopThinking(pi: ExtensionAPI): void {
  // Partial thinking of the assistant message that is streaming now. Undefined outside the
  // thinking phase, so the key does nothing while the model writes its answer or calls a tool.
  let thinking: string | undefined;
  let latestContext: StopContext | undefined;
  let buttonVisible = false;
  // A stop that waits for the aborted request to settle.
  let requested: StopRequest | undefined;
  // A stop whose new turn has started; the next provider request carries the continuation.
  let continuation: StopRequest | undefined;
  let rewritten = false;

  function reset(): void {
    thinking = undefined;
    requested = undefined;
    continuation = undefined;
    rewritten = false;
  }

  function stop(ctx: StopContext): void {
    if (requested !== undefined || continuation !== undefined) {
      return;
    }
    if (thinking === undefined) {
      if (ctx.hasUI !== false) {
        ctx.ui.notify("The model is not thinking now.", "info");
      }
      return;
    }
    requested = { provider: ctx.model?.provider ?? "", thinking };
    hideButton(ctx);
    ctx.abort();
  }

  function showButton(ctx: StopContext): void {
    if (buttonVisible || ctx.mode !== "tui") {
      return;
    }
    buttonVisible = true;
    ctx.ui.setWidget(widgetKey, (_tui: unknown, theme: ThemeLike) => ({
      render(width: number): string[] {
        return [buttonLine(theme, width)];
      },
      invalidate(): void {},
      handleMouse(event: MouseEventLike) {
        if (event.button !== "left" || event.x >= buttonLabel.length) {
          return undefined;
        }
        if (event.type === "click" && latestContext !== undefined) {
          stop(latestContext);
        }
        return { handled: true };
      }
    }));
  }

  function hideButton(ctx: StopContext): void {
    if (!buttonVisible) {
      return;
    }
    buttonVisible = false;
    ctx.ui.setWidget(widgetKey, undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    reset();
    latestContext = ctx;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    hideButton(ctx);
    reset();
  });

  pi.on("message_update", (event, ctx) => {
    latestContext = ctx;
    const message = event.message as MessageLike;
    if (message.role !== "assistant" || requested !== undefined) {
      return;
    }
    if (isThinkingPhase(message)) {
      thinking = thinkingText(message);
      showButton(ctx);
      return;
    }
    thinking = undefined;
    hideButton(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message as MessageLike;
    if (message.role !== "assistant") {
      return;
    }
    thinking = undefined;
    hideButton(ctx);
    if (requested !== undefined) {
      if (message.stopReason === "aborted") {
        // The final aborted message holds every thinking token that arrived before the abort.
        const finalThinking = thinkingText(message);
        if (finalThinking.length >= requested.thinking.length) {
          requested.thinking = finalThinking;
        }
      } else {
        // The model finished on its own before the abort landed, so there is nothing to stop.
        requested = undefined;
      }
      return;
    }
    if (continuation !== undefined && rewritten && message.stopReason !== "error") {
      continuation = undefined;
      rewritten = false;
    }
  });

  pi.on("agent_settled", () => {
    if (requested === undefined) {
      return;
    }
    continuation = requested;
    requested = undefined;
    rewritten = false;
    pi.sendMessage({ customType, content: instruction, display: true }, { triggerTurn: true });
  });

  pi.on("before_provider_request", (event) => {
    if (continuation === undefined) {
      return undefined;
    }
    const payload = continuationPayload(event.payload, continuation);
    if (payload !== undefined) {
      rewritten = true;
    }
    return payload;
  });

  pi.registerMessageRenderer(customType, (_message, _options, theme) => ({
    render(width: number): string[] {
      return [fit(theme.fg("muted", "Stopped thinking. Answering now."), "Stopped thinking. Answering now.", width)];
    },
    invalidate(): void {}
  }));

  pi.registerCommand("stop-thinking", {
    description: "Stop the model's thinking and get the answer now",
    handler: async (_args, ctx) => {
      stop(ctx);
    }
  });

  if (shortcut !== undefined) {
    pi.registerShortcut(shortcut, {
      description: "Stop thinking and answer now",
      handler: (ctx) => {
        stop(ctx);
      }
    });
  }
}

function blocks(message: MessageLike): readonly ContentBlock[] {
  return Array.isArray(message.content) ? (message.content as ContentBlock[]) : [];
}

function isThinkingPhase(message: MessageLike): boolean {
  let hasThinking = false;
  for (const block of blocks(message)) {
    if (block.type === "thinking") {
      hasThinking = true;
    } else if (block.type === "toolCall") {
      return false;
    } else if (block.type === "text" && (block.text ?? "").trim().length > 0) {
      return false;
    }
  }
  return hasThinking;
}

function thinkingText(message: MessageLike): string {
  return blocks(message)
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking ?? "")
    .join("\\n");
}

function buttonLine(theme: ThemeLike, width: number): string {
  const hint = shortcut === undefined ? "" : \`  \${shortcut}\`;
  return fit(theme.fg("accent", buttonLabel) + theme.fg("dim", hint), buttonLabel + hint, width);
}

// Styled text cannot be cut safely, so a line that does not fit falls back to plain text.
function fit(styled: string, plain: string, width: number): string {
  return plain.length <= width ? styled : plain.slice(0, Math.max(0, width));
}

/**
 * Rewrite only the request that follows a stop. The last message must be the stop instruction, so
 * a normal request never changes.
 */
function continuationPayload(payload: unknown, stop: StopRequest): unknown {
  if (!isRecord(payload) || !Array.isArray(payload["messages"])) {
    return undefined;
  }
  const messages = payload["messages"] as unknown[];
  if (!isStopInstruction(messages[messages.length - 1])) {
    return undefined;
  }
  if (nativeProviders.has(stop.provider)) {
    // llama.cpp skips a continuation whose message is empty, so a stop that came before the first
    // thinking token still sends one newline. The server then closes the thinking at once.
    const prefill: PayloadMessage = {
      role: "assistant",
      content: "",
      reasoning_content: stop.thinking.trim().length > 0 ? stop.thinking : "\\n"
    };
    return {
      ...payload,
      messages: [...messages.slice(0, -1), prefill],
      // llama.cpp rejects an explicit continuation together with a generation prompt.
      add_generation_prompt: false,
      continue_final_message: "content"
    };
  }
  if (templateKwargsProviders.has(stop.provider)) {
    const kwargs = isRecord(payload["chat_template_kwargs"]) ? payload["chat_template_kwargs"] : {};
    return { ...payload, chat_template_kwargs: { ...kwargs, enable_thinking: false } };
  }
  return undefined;
}

function isStopInstruction(value: unknown): boolean {
  if (!isRecord(value) || value["role"] !== "user") {
    return false;
  }
  const content = value["content"];
  if (typeof content === "string") {
    return content === instruction;
  }
  if (!Array.isArray(content) || content.length !== 1) {
    return false;
  }
  const part: unknown = content[0];
  return isRecord(part) && part["type"] === "text" && part["text"] === instruction;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
`;
}

function providersFor(engines: readonly EngineEntry[], labels: ReadonlySet<string>): string[] {
  return engines.filter((entry) => labels.has(entry.engine)).map((entry) => entry.provider);
}
