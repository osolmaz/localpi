import { afterEach, describe, expect, it, vi } from "vitest";

import { stopThinkingExtensionSource } from "../src/pi/extension-sources/stop-thinking.js";
import { cleanupTemporaryDirs, loadGeneratedExtension } from "./support/extension-harness.js";

type Handler = (event: unknown, ctx: FakeContext) => unknown;

type WidgetComponent = {
  render(width: number): string[];
  handleMouse(event: { type: string; button: string; x: number; y: number }): unknown;
};

type WidgetFactory = (tui: unknown, theme: FakeTheme) => WidgetComponent;

type FakeTheme = { fg(color: string, text: string): string };

type FakeContext = {
  readonly mode: string;
  readonly hasUI: boolean;
  readonly model: { readonly provider: string };
  aborts: number;
  readonly notices: string[];
  widget: WidgetFactory | undefined;
  abort(): void;
  readonly ui: {
    notify(message: string): void;
    setWidget(key: string, content: WidgetFactory | undefined): void;
  };
};

type SentMessage = {
  readonly message: { customType: string; content: string; display: boolean };
  readonly options: unknown;
};

type FakePi = {
  readonly handlers: Map<string, Handler>;
  readonly shortcuts: Map<string, (ctx: FakeContext) => void>;
  readonly commands: Map<string, (args: string, ctx: FakeContext) => Promise<void>>;
  readonly renderers: Map<string, unknown>;
  readonly sent: SentMessage[];
  thinkingLevel: string;
};

const instruction = "Stop thinking now. Give your answer based on the reasoning you have so far.";
const plainTheme: FakeTheme = { fg: (_color, text) => text };

afterEach(async () => {
  vi.useRealTimers();
  await cleanupTemporaryDirs();
});

describe("generated localpi stop thinking extension", () => {
  it("registers the key, the command, and the message renderer", async () => {
    const pi = await startPi();

    expect([...pi.shortcuts.keys()]).toEqual(["ctrl+shift+s"]);
    expect([...pi.commands.keys()]).toEqual(["stop-thinking"]);
    expect([...pi.renderers.keys()]).toEqual(["localpi-stop-thinking"]);
  });

  it("registers no key when the key is off, and keeps the command", async () => {
    const pi = await startPi({ key: undefined });

    expect(pi.shortcuts.size).toBe(0);
    expect([...pi.commands.keys()]).toEqual(["stop-thinking"]);
  });

  it("does nothing but notify when the model is not thinking", async () => {
    const pi = await startPi();
    const ctx = context();

    await pi.handlers.get("message_update")?.(update([text("The answer")]), ctx);
    pi.shortcuts.get("ctrl+shift+s")?.(ctx);

    expect(ctx.aborts).toBe(0);
    expect(ctx.notices).toEqual(["The model is not thinking now."]);
  });

  it("aborts during thinking and continues the partial thinking as content on llama.cpp", async () => {
    const pi = await startPi();
    const ctx = context();

    await pi.handlers.get("message_update")?.(update([thinking("Let me think")]), ctx);
    pi.shortcuts.get("ctrl+shift+s")?.(ctx);
    await pi.handlers.get("message_end")?.(end("aborted", [thinking("Let me think more")]), ctx);
    await pi.handlers.get("agent_settled")?.({}, ctx);

    expect(ctx.aborts).toBe(1);
    expect(pi.sent).toEqual([
      {
        message: { customType: "localpi-stop-thinking", content: instruction, display: true },
        options: { triggerTurn: true }
      }
    ]);

    const payload = await pi.handlers.get("before_provider_request")?.(
      { payload: request([userMessage("What is 2+2?"), instructionMessage()]) },
      ctx
    );
    expect(payload).toEqual({
      model: "local",
      stream: true,
      messages: [
        userMessage("What is 2+2?"),
        { role: "assistant", content: "", reasoning_content: "Let me think more" }
      ],
      add_generation_prompt: false,
      continue_final_message: "content"
    });
  });

  it("disables thinking for the answer on vLLM and keeps the instruction", async () => {
    const pi = await startPi();
    const ctx = context("vllm");

    await stopDuringThinking(pi, ctx, "Hmm");
    const payload = await pi.handlers.get("before_provider_request")?.(
      {
        payload: {
          ...request([instructionMessage()]),
          chat_template_kwargs: { preserve_thinking: true }
        }
      },
      ctx
    );

    expect(payload).toEqual({
      ...request([instructionMessage()]),
      chat_template_kwargs: { preserve_thinking: true, enable_thinking: false }
    });
  });

  it("sends only the instruction to an engine it does not know", async () => {
    const pi = await startPi();
    const ctx = context("local-openai");

    await stopDuringThinking(pi, ctx, "Hmm");
    const payload = await pi.handlers.get("before_provider_request")?.(
      { payload: request([instructionMessage()]) },
      ctx
    );

    expect(payload).toBeUndefined();
  });

  it("closes the thinking at once on llama.cpp when no thinking text arrived yet", async () => {
    const pi = await startPi();
    const ctx = context();

    await stopDuringThinking(pi, ctx, "");
    const payload = await pi.handlers.get("before_provider_request")?.(
      { payload: request([userMessage("What is 7*8?"), instructionMessage()]) },
      ctx
    );

    expect(payload).toEqual({
      ...request([
        userMessage("What is 7*8?"),
        { role: "assistant", content: "", reasoning_content: "\n" }
      ]),
      add_generation_prompt: false,
      continue_final_message: "content"
    });
  });

  it("leaves every request alone when no stop is pending", async () => {
    const pi = await startPi();

    const payload = await pi.handlers.get("before_provider_request")?.(
      { payload: request([instructionMessage()]) },
      context()
    );

    expect(payload).toBeUndefined();
  });

  it("rewrites only a request that ends with the stop instruction", async () => {
    const pi = await startPi();
    const ctx = context();

    await stopDuringThinking(pi, ctx, "Hmm");
    const other = await pi.handlers.get("before_provider_request")?.(
      { payload: request([userMessage("Something else")]) },
      ctx
    );
    const stringContent = await pi.handlers.get("before_provider_request")?.(
      { payload: request([{ role: "user", content: instruction }]) },
      ctx
    );

    expect(other).toBeUndefined();
    expect(stringContent).toMatchObject({ continue_final_message: "content" });
  });

  it("clears the continuation when the continuation run settles", async () => {
    const pi = await startPi();
    const ctx = context();

    await stopDuringThinking(pi, ctx, "Hmm");
    await pi.handlers.get("before_provider_request")?.(
      { payload: request([instructionMessage()]) },
      ctx
    );
    await pi.handlers.get("message_end")?.(end("stop", [text("4")]), ctx);
    await pi.handlers.get("agent_settled")?.({}, ctx);
    const later = await pi.handlers.get("before_provider_request")?.(
      { payload: request([instructionMessage()]) },
      ctx
    );

    expect(later).toBeUndefined();
  });

  it("keeps the continuation for a retry after an error", async () => {
    const pi = await startPi();
    const ctx = context();

    await stopDuringThinking(pi, ctx, "Hmm");
    await pi.handlers.get("before_provider_request")?.(
      { payload: request([instructionMessage()]) },
      ctx
    );
    await pi.handlers.get("message_end")?.(end("error", []), ctx);
    const retry = await pi.handlers.get("before_provider_request")?.(
      { payload: request([instructionMessage()]) },
      ctx
    );

    expect(retry).toMatchObject({ continue_final_message: "content" });
  });

  it("stops again after a continuation on an engine it does not rewrite", async () => {
    const pi = await startPi();
    const ctx = context("local-openai");

    await stopDuringThinking(pi, ctx, "Hmm");
    await pi.handlers.get("before_provider_request")?.(
      { payload: request([instructionMessage()]) },
      ctx
    );
    await pi.handlers.get("message_end")?.(end("stop", [text("4")]), ctx);
    await pi.handlers.get("agent_settled")?.({}, ctx);
    await stopDuringThinking(pi, ctx, "More");

    expect(ctx.aborts).toBe(2);
    expect(pi.sent).toHaveLength(2);
  });

  it("stops again when the continuation run starts thinking again", async () => {
    const pi = await startPi();
    const ctx = context("local-openai");

    await stopDuringThinking(pi, ctx, "Hmm");
    await pi.handlers.get("message_update")?.(update([thinking("Thinking again")]), ctx);
    await pi.commands.get("stop-thinking")?.("", ctx);

    expect(ctx.aborts).toBe(2);
  });

  it("finishes the stopped message as a normal stop instead of an abort", async () => {
    const pi = await startPi();
    const ctx = context();

    await pi.handlers.get("message_update")?.(update([thinking("Hmm")]), ctx);
    pi.shortcuts.get("ctrl+shift+s")?.(ctx);
    const replaced = await pi.handlers.get("message_end")?.(
      {
        message: {
          role: "assistant",
          stopReason: "aborted",
          errorMessage: "Request was aborted",
          content: [thinking("Hmm")]
        }
      },
      ctx
    );

    expect(replaced).toEqual({
      message: { role: "assistant", stopReason: "stop", content: [thinking("Hmm")] }
    });
  });

  it("leaves an abort by the user's own Escape alone", async () => {
    const pi = await startPi();
    const ctx = context();

    await pi.handlers.get("message_update")?.(update([thinking("Hmm")]), ctx);
    const replaced = await pi.handlers.get("message_end")?.(end("aborted", [thinking("Hmm")]), ctx);

    expect(replaced).toBeUndefined();
  });

  it("renders the stop notice padded like assistant text", async () => {
    const pi = await startPi();
    const renderer = pi.renderers.get("localpi-stop-thinking") as (
      message: unknown,
      options: { expanded: boolean; outputPad: number },
      theme: FakeTheme
    ) => { render(width: number): string[] };

    const component = renderer({}, { expanded: false, outputPad: 1 }, plainTheme);

    expect(component.render(80)).toEqual([" Stopped thinking. Answering now."]);
    expect(component.render(9)).toEqual([" Stopped "]);
  });

  it("drops the stop when the model finished before the abort landed", async () => {
    const pi = await startPi();
    const ctx = context();

    await pi.handlers.get("message_update")?.(update([thinking("Hmm")]), ctx);
    pi.shortcuts.get("ctrl+shift+s")?.(ctx);
    await pi.handlers.get("message_end")?.(end("stop", [thinking("Hmm"), text("4")]), ctx);
    await pi.handlers.get("agent_settled")?.({}, ctx);

    expect(pi.sent).toHaveLength(0);
  });

  it("ignores a second press while a stop is pending", async () => {
    const pi = await startPi();
    const ctx = context();

    await pi.handlers.get("message_update")?.(update([thinking("Hmm")]), ctx);
    pi.shortcuts.get("ctrl+shift+s")?.(ctx);
    pi.shortcuts.get("ctrl+shift+s")?.(ctx);
    await pi.commands.get("stop-thinking")?.("", ctx);

    expect(ctx.aborts).toBe(1);
    expect(ctx.notices).toEqual([]);
  });

  it("ends the thinking phase when the answer or a tool call starts", async () => {
    const pi = await startPi();
    const ctx = context();

    await pi.handlers.get("message_update")?.(update([thinking("Hmm")]), ctx);
    await pi.handlers.get("message_update")?.(update([thinking("Hmm"), toolCall()]), ctx);
    await pi.commands.get("stop-thinking")?.("", ctx);

    expect(ctx.aborts).toBe(0);
    expect(ctx.widget).toBeUndefined();
  });

  it("shows the button with its key hint only while the model thinks in the TUI", async () => {
    const pi = await startPi();
    const ctx = context();

    await pi.handlers.get("message_update")?.(update([thinking("Hmm")]), ctx);
    const widget = button(ctx);

    expect(widget.render(80)).toEqual([" [ Stop thinking and answer ]  ctrl+shift+s", ""]);
    expect(widget.render(10)).toEqual([" [ Stop th", ""]);
  });

  it("stops on a left click on the button", async () => {
    const pi = await startPi();
    const ctx = context();

    await pi.handlers.get("message_update")?.(update([thinking("Hmm")]), ctx);
    const widget = button(ctx);

    expect(widget.handleMouse({ type: "press", button: "right", x: 2, y: 0 })).toBeUndefined();
    expect(widget.handleMouse({ type: "press", button: "left", x: 40, y: 0 })).toBeUndefined();
    expect(widget.handleMouse({ type: "press", button: "left", x: 0, y: 0 })).toBeUndefined();
    expect(widget.handleMouse({ type: "press", button: "left", x: 2, y: 1 })).toBeUndefined();
    expect(widget.handleMouse({ type: "press", button: "left", x: 2, y: 0 })).toEqual({
      handled: true
    });
    expect(ctx.aborts).toBe(0);
    expect(widget.handleMouse({ type: "click", button: "left", x: 2, y: 0 })).toEqual({
      handled: true
    });
    expect(ctx.aborts).toBe(1);
    expect(ctx.widget).toBeUndefined();
  });

  it("waits for the delay before it shows the button", async () => {
    vi.useFakeTimers();
    const pi = await startPi({ buttonDelayMs: 5000 });
    const ctx = context();

    await pi.handlers.get("message_update")?.(update([thinking("Hmm")]), ctx);
    vi.advanceTimersByTime(4999);
    await pi.handlers.get("message_update")?.(update([thinking("Hmm, more")]), ctx);
    expect(ctx.widget).toBeUndefined();

    vi.advanceTimersByTime(1);
    expect(button(ctx).render(80)[0]).toContain("Stop thinking and answer");
  });

  it("shows no button when the thinking ends before the delay", async () => {
    vi.useFakeTimers();
    const pi = await startPi({ buttonDelayMs: 5000 });
    const ctx = context();

    await pi.handlers.get("message_update")?.(update([thinking("Hmm")]), ctx);
    vi.advanceTimersByTime(3000);
    await pi.handlers.get("message_update")?.(update([thinking("Hmm"), text("4")]), ctx);
    vi.advanceTimersByTime(5000);

    expect(ctx.widget).toBeUndefined();
  });

  it("accepts the key before the button shows", async () => {
    vi.useFakeTimers();
    const pi = await startPi({ buttonDelayMs: 5000 });
    const ctx = context();

    await pi.handlers.get("message_update")?.(update([thinking("Hmm")]), ctx);
    pi.shortcuts.get("ctrl+shift+s")?.(ctx);
    vi.advanceTimersByTime(5000);

    expect(ctx.aborts).toBe(1);
    expect(ctx.widget).toBeUndefined();
  });

  it("shows no button outside the TUI", async () => {
    const pi = await startPi();
    const ctx = { ...context(), mode: "rpc" };

    await pi.handlers.get("message_update")?.(update([thinking("Hmm")]), ctx);

    expect(ctx.widget).toBeUndefined();
  });

  it("drops the key hint from the button when the key is off", async () => {
    const pi = await startPi({ key: undefined });
    const ctx = context();

    await pi.handlers.get("message_update")?.(update([thinking("Hmm")]), ctx);

    expect(ctx.widget?.(undefined, plainTheme).render(80)).toEqual([
      " [ Stop thinking and answer ]",
      ""
    ]);
  });

  it.each(["llama-cpp", "vllm"])(
    "caps the first %s request and reserves the rest for an answer-only continuation",
    async (provider) => {
      const pi = await startPi({ endpointThinkingBudget: 8000 });
      const ctx = context(provider);
      const first = await pi.handlers.get("before_provider_request")?.(
        { payload: { ...request([userMessage("Solve it")]), max_tokens: 16384 } },
        ctx
      );
      expect(first).toMatchObject({ max_tokens: 8000 });
      expect(
        await pi.handlers.get("message_end")?.(end("length", [thinking("Partial reasoning")]), ctx)
      ).toBeUndefined();
      await pi.handlers.get("agent_settled")?.({}, ctx);
      expect(pi.sent).toHaveLength(1);
      const answer = await pi.handlers.get("before_provider_request")?.(
        {
          payload: {
            ...request([userMessage("Solve it"), instructionMessage()]),
            max_tokens: 16384
          }
        },
        ctx
      );
      expect(answer).toMatchObject({ max_tokens: 8384 });
      if (provider === "vllm") {
        expect(answer).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
      } else {
        expect(answer).toMatchObject({ continue_final_message: "content" });
      }
      await pi.handlers.get("message_end")?.(end("stop", [text("The answer")]), ctx);
      await pi.handlers.get("agent_settled")?.({}, ctx);
      expect(pi.sent).toHaveLength(1);
    }
  );

  it("never forces an answer when a capped request ended with answer text or an error", async () => {
    const pi = await startPi({ endpointThinkingBudget: 8000 });
    const ctx = context("vllm");
    for (const [reason, content] of [
      ["length", [thinking("Reasoning"), text("Partial answer")]],
      ["error", [thinking("Reasoning")]],
      ["length", [thinking("Reasoning"), toolCall()]]
    ] as const) {
      await pi.handlers.get("before_provider_request")?.(
        { payload: { ...request([userMessage("Solve it")]), max_tokens: 16384 } },
        ctx
      );
      await pi.handlers.get("message_end")?.(end(reason, content), ctx);
      await pi.handlers.get("agent_settled")?.({}, ctx);
    }
    expect(pi.sent).toHaveLength(0);
  });

  it("does not cap unsupported providers or thinking-off requests", async () => {
    const pi = await startPi({ endpointThinkingBudget: 8000 });
    const payload = { ...request([userMessage("Solve it")]), max_completion_tokens: 16384 };
    expect(
      await pi.handlers.get("before_provider_request")?.({ payload }, context("lmstudio"))
    ).toBeUndefined();
    pi.thinkingLevel = "off";
    expect(
      await pi.handlers.get("before_provider_request")?.({ payload }, context("vllm"))
    ).toBeUndefined();
    pi.thinkingLevel = "high";
    expect(
      await pi.handlers.get("before_provider_request")?.({ payload }, context("vllm"))
    ).toMatchObject({ max_completion_tokens: 8000 });
  });

  it("fails closed when the endpoint has no room for an answer", async () => {
    const pi = await startPi({ endpointThinkingBudget: 8000 });
    const handler = pi.handlers.get("before_provider_request");
    const ctx = context("vllm");
    expect(() => handler?.({ payload: request([userMessage("Solve it")]) }, ctx)).toThrow(
      "requires a positive output limit"
    );
    expect(() =>
      handler?.({ payload: { ...request([userMessage("Solve it")]), max_tokens: 8000 } }, ctx)
    ).toThrow("must leave output tokens for the answer");
  });

  it("starts over when a new session begins", async () => {
    const pi = await startPi();
    const ctx = context();

    await pi.handlers.get("message_update")?.(update([thinking("Hmm")]), ctx);
    pi.shortcuts.get("ctrl+shift+s")?.(ctx);
    await pi.handlers.get("session_start")?.({}, ctx);
    await pi.handlers.get("agent_settled")?.({}, ctx);

    expect(pi.sent).toHaveLength(0);
  });
});

async function startPi(
  config: { key?: string | undefined; buttonDelayMs?: number; endpointThinkingBudget?: number } = {}
): Promise<FakePi> {
  const extension = await loadGeneratedExtension(
    stopThinkingExtensionSource({
      key: "key" in config ? config.key : "ctrl+shift+s",
      // Most tests look at the button itself, so they show it at once.
      buttonDelayMs: config.buttonDelayMs ?? 0,
      endpointThinkingBudget: config.endpointThinkingBudget,
      engines: [
        { provider: "llama-cpp", engine: "llama.cpp" },
        { provider: "llama-server", engine: "llama-server" },
        { provider: "vllm", engine: "vLLM" },
        { provider: "lmstudio", engine: "LM Studio" }
      ]
    })
  );
  const pi: FakePi = {
    handlers: new Map(),
    shortcuts: new Map(),
    commands: new Map(),
    renderers: new Map(),
    sent: [],
    thinkingLevel: "high"
  };
  extension({
    on: (event: string, handler: Handler) => {
      pi.handlers.set(event, handler);
    },
    registerShortcut: (key: string, options: { handler: (ctx: FakeContext) => void }) => {
      pi.shortcuts.set(key, options.handler);
    },
    registerCommand: (
      name: string,
      options: { handler: (args: string, ctx: FakeContext) => Promise<void> }
    ) => {
      pi.commands.set(name, options.handler);
    },
    registerMessageRenderer: (customType: string, renderer: unknown) => {
      pi.renderers.set(customType, renderer);
    },
    getThinkingLevel: () => pi.thinkingLevel,
    sendMessage: (message: SentMessage["message"], options: unknown) => {
      pi.sent.push({ message, options });
    }
  });
  return pi;
}

function context(provider = "llama-cpp"): FakeContext {
  const ctx: FakeContext = {
    mode: "tui",
    hasUI: true,
    model: { provider },
    aborts: 0,
    notices: [],
    widget: undefined,
    abort: () => {
      ctx.aborts += 1;
    },
    ui: {
      notify: (message) => {
        ctx.notices.push(message);
      },
      setWidget: (_key, content) => {
        ctx.widget = content;
      }
    }
  };
  return ctx;
}

function button(ctx: FakeContext): WidgetComponent {
  if (ctx.widget === undefined) {
    throw new Error("the stop button is not shown");
  }
  return ctx.widget(undefined, plainTheme);
}

async function stopDuringThinking(pi: FakePi, ctx: FakeContext, partial: string): Promise<void> {
  await pi.handlers.get("message_update")?.(update([thinking(partial)]), ctx);
  pi.shortcuts.get("ctrl+shift+s")?.(ctx);
  await pi.handlers.get("message_end")?.(end("aborted", [thinking(partial)]), ctx);
  await pi.handlers.get("agent_settled")?.({}, ctx);
}

function update(content: readonly unknown[]): unknown {
  return { message: { role: "assistant", content } };
}

function end(stopReason: string, content: readonly unknown[]): unknown {
  return { message: { role: "assistant", stopReason, content } };
}

function thinking(value: string): unknown {
  return { type: "thinking", thinking: value };
}

function text(value: string): unknown {
  return { type: "text", text: value };
}

function toolCall(): unknown {
  return { type: "toolCall", id: "call-1", name: "read", arguments: {} };
}

function userMessage(value: string): unknown {
  return { role: "user", content: [{ type: "text", text: value }] };
}

function instructionMessage(): unknown {
  return userMessage(instruction);
}

function request(messages: readonly unknown[]): Record<string, unknown> {
  return { model: "local", stream: true, messages };
}
