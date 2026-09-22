import { afterEach, describe, expect, it } from "vitest";

import { engineStatusExtensionSource } from "../src/pi/extension-sources/engine-status.js";
import { cleanupTemporaryDirs, loadGeneratedExtension } from "./support/extension-harness.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

type FakePi = {
  readonly handlers: Map<string, Handler>;
  readonly on: (event: string, handler: Handler) => void;
};

type FakeContext = {
  readonly ctx: unknown;
  readonly statuses: (string | undefined)[];
};

const engines = [
  { provider: "llama-cpp", engine: "llama.cpp" },
  { provider: "vllm", engine: "vLLM" }
];

afterEach(async () => {
  await cleanupTemporaryDirs();
});

describe("generated localpi engine status extension", () => {
  it("shows the engine of the model at session start", async () => {
    const pi = await startPi();
    const fake = fakeContext();

    pi.handlers.get("session_start")?.({}, fake.ctx);

    expect(fake.statuses.at(-1)).toBe("llama.cpp");
  });

  it("follows a model change to another engine", async () => {
    const pi = await startPi();
    const fake = fakeContext();

    pi.handlers.get("session_start")?.({}, fake.ctx);
    pi.handlers.get("model_select")?.({ model: { provider: "vllm" } }, fake.ctx);

    expect(fake.statuses.at(-1)).toBe("vLLM");
  });

  it("clears the label for a provider whose engine is unknown", async () => {
    const pi = await startPi();
    const fake = fakeContext();

    pi.handlers.get("session_start")?.({}, fake.ctx);
    pi.handlers.get("model_select")?.({ model: { provider: "my-endpoint" } }, fake.ctx);

    expect(fake.statuses.at(-1)).toBeUndefined();
  });

  it("clears the label when the session ends", async () => {
    const pi = await startPi();
    const fake = fakeContext();

    pi.handlers.get("session_start")?.({}, fake.ctx);
    pi.handlers.get("session_shutdown")?.({}, fake.ctx);

    expect(fake.statuses.at(-1)).toBeUndefined();
  });

  it("writes the launch-time engine map into the extension", () => {
    const source = engineStatusExtensionSource({ engines });

    expect(source).toContain('[{"provider":"llama-cpp","engine":"llama.cpp"}');
    expect(source).toContain('const statusKey = "localpi-engine";');
  });
});

async function startPi(): Promise<FakePi> {
  const extension = await loadGeneratedExtension(engineStatusExtensionSource({ engines }));
  const pi = fakePi();
  extension(pi);
  return pi;
}

function fakePi(): FakePi {
  return {
    handlers: new Map<string, Handler>(),
    on(event, handler) {
      this.handlers.set(event, handler);
    }
  };
}

function fakeContext(): FakeContext {
  const statuses: (string | undefined)[] = [];
  return {
    statuses,
    ctx: {
      model: { provider: "llama-cpp" },
      ui: {
        setStatus: (_key: string, text: string | undefined) => {
          statuses.push(text);
        }
      }
    }
  };
}
