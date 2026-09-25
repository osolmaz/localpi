import { afterEach, describe, expect, it } from "vitest";

import { parseLocalpiArgs, parsePiCommand, usage } from "../src/localpi/options.js";

describe("localpi option parsing", () => {
  it("keeps pi args as pass-through arguments", () => {
    const options = parseLocalpiArgs(["--model", "gemma-e4b", "-p", "write a plan"]);
    expect(options.model).toBe("gemma-e4b");
    expect(options.forwardedArgs).toEqual(["-p", "write a plan"]);
  });

  it("uses -- to forward pi flags that localpi also owns", () => {
    const options = parseLocalpiArgs(["--model", "gemma-e4b", "--", "--model", "pi-level"]);
    expect(options.model).toBe("gemma-e4b");
    expect(options.forwardedArgs).toEqual(["--model", "pi-level"]);
  });

  it("parses runtime and llama-server options", () => {
    const options = parseLocalpiArgs([
      "--runtime",
      "lmstudio",
      "--base-url",
      "http://127.0.0.1:1234/v1/",
      "--ctx",
      "32768",
      "--port",
      "18195",
      "--no-approval",
      "--approve-read-tools",
      "--no-token-status"
    ]);
    expect(options.runtime).toBe("lmstudio");
    expect(options.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(options.contextWindow).toBe(32768);
    expect(options.port).toBe(18195);
    expect(options.approval).toBe(false);
    expect(options.approveReadTools).toBe(true);
    expect(options.stats).toBe("off");
    expect(parseLocalpiArgs(["--runtime", "vllm"]).runtime).toBe("vllm");
  });

  it("keeps read-only tools out of the approval gate by default", () => {
    expect(parseLocalpiArgs([]).approveReadTools).toBe(false);
    expect(parseLocalpiArgs(["--approve-read-tools"]).approveReadTools).toBe(true);
  });

  it("parses and validates stats modes", () => {
    expect(parseLocalpiArgs([]).stats).toBe("full");
    expect(parseLocalpiArgs(["--stats", "line"]).stats).toBe("line");
    expect(parseLocalpiArgs(["--stats", "off"]).stats).toBe("off");
    expect(() => parseLocalpiArgs(["--stats", "banana"])).toThrow(
      "unknown stats mode banana; expected off, line, or full"
    );
  });

  it("parses and validates skills modes", () => {
    expect(parseLocalpiArgs([]).skills).toBe("own");
    expect(parseLocalpiArgs(["--skills", "ambient"]).skills).toBe("ambient");
    expect(parseLocalpiArgs(["--skills", "off"]).skills).toBe("off");
    expect(parseLocalpiArgs(["--no-skills"]).skills).toBe("off");
    expect(() => parseLocalpiArgs(["--skills", "banana"])).toThrow(
      "unknown skills mode banana; expected own, ambient, or off"
    );
  });

  it("parses and validates the stop thinking key", () => {
    expect(parseLocalpiArgs([]).stopThinkingKey).toBe("ctrl+shift+s");
    expect(parseLocalpiArgs(["--stop-thinking-key", "alt+s"]).stopThinkingKey).toBe("alt+s");
    expect(parseLocalpiArgs(["--stop-thinking-key", "ctrl+alt+f5"]).stopThinkingKey).toBe(
      "ctrl+alt+f5"
    );
    expect(parseLocalpiArgs(["--stop-thinking-key", "ctrl+pageDown"]).stopThinkingKey).toBe(
      "ctrl+pageDown"
    );
    expect(parseLocalpiArgs(["--stop-thinking-key", "ctrl+/"]).stopThinkingKey).toBe("ctrl+/");
    expect(parseLocalpiArgs(["--stop-thinking-key", "off"]).stopThinkingKey).toBeUndefined();
    for (const invalid of ["s", "ctrl+", "ctrl+ctrl+s", "hyper+s", "ctrl+shift+enterx", ""]) {
      expect(() => parseLocalpiArgs(["--stop-thinking-key", invalid])).toThrow(
        `unknown stop thinking key ${invalid}; expected off or a modified key such as ctrl+shift+s`
      );
    }
  });

  it("parses and validates the stop thinking button delay", () => {
    expect(parseLocalpiArgs([]).stopThinkingDelay).toBe(5);
    expect(parseLocalpiArgs(["--stop-thinking-delay", "0"]).stopThinkingDelay).toBe(0);
    expect(parseLocalpiArgs(["--stop-thinking-delay", "2.5"]).stopThinkingDelay).toBe(2.5);
    for (const invalid of ["-1", "five", "1e3", ".5", ""]) {
      expect(() => parseLocalpiArgs(["--stop-thinking-delay", invalid])).toThrow(
        `unknown stop thinking delay ${invalid}; expected a number of seconds, 0 or more`
      );
    }
  });

  it("parses the web mode options", () => {
    const defaults = parseLocalpiArgs([]);
    expect(defaults).toMatchObject({
      web: false,
      webPort: 0,
      webOpen: true,
      webHost: "127.0.0.1",
      webAllowedHosts: []
    });
    expect(
      parseLocalpiArgs([
        "--web",
        "--web-port",
        "8421",
        "--no-browser",
        "--web-host",
        "100.64.0.1",
        "--web-allowed-hosts",
        "box, box.tailnet.ts.net,"
      ])
    ).toMatchObject({
      web: true,
      webPort: 8421,
      webOpen: false,
      webHost: "100.64.0.1",
      webAllowedHosts: ["box", "box.tailnet.ts.net"]
    });
    expect(parseLocalpiArgs([]).webTheme).toBe("latte");
    expect(parseLocalpiArgs(["--web-theme", "frappe"]).webTheme).toBe("frappe");
    expect(() => parseLocalpiArgs(["--web-theme", "dracula"])).toThrow(
      "unknown web theme dracula; expected latte, frappe, macchiato, or mocha"
    );
    expect(() => parseLocalpiArgs(["--web-port", "-1"])).toThrow(
      "expected a non-negative integer, got -1"
    );
  });

  it("parses and validates thinking levels", () => {
    expect(parseLocalpiArgs(["--thinking", "low"])).toMatchObject({
      thinking: "low"
    });
    expect(parseLocalpiArgs(["--thinking", "xhigh"])).toMatchObject({
      thinking: "xhigh"
    });
    expect(() => parseLocalpiArgs(["--thinking", "banana"])).toThrow(
      "unknown thinking level banana"
    );
  });

  it("parses and validates thinking budgets", () => {
    expect(parseLocalpiArgs(["--thinking-budget", "4096"]).thinkingBudget).toBe(4096);
    expect(parseLocalpiArgs(["--thinking-budget", "-1"]).thinkingBudget).toBe(-1);
    expect(parseLocalpiArgs([]).thinkingBudget).toBeUndefined();
    expect(() => parseLocalpiArgs(["--thinking-budget", "0"])).toThrow(
      "unknown thinking budget 0; expected -1 or a positive integer"
    );
    expect(() => parseLocalpiArgs(["--thinking-budget", "half"])).toThrow(
      "unknown thinking budget half; expected -1 or a positive integer"
    );
    expect(usage()).toContain("--thinking-budget <n>");
  });

  it("keeps the endpoint output cap off unless explicitly set", () => {
    expect(parseLocalpiArgs([]).thinkingPhaseOutputCap).toBeUndefined();
    expect(parseLocalpiArgs(["--thinking-phase-output-cap", "8000"]).thinkingPhaseOutputCap).toBe(
      8000
    );
    expect(() => parseLocalpiArgs(["--thinking-phase-output-cap", "0"])).toThrow();
    expect(() => parseLocalpiArgs(["--thinking-phase-output-cap", "-1"])).toThrow();
    process.env["LOCALPI_THINKING_PHASE_OUTPUT_CAP"] = "4096";
    expect(parseLocalpiArgs([]).thinkingPhaseOutputCap).toBe(4096);
    expect(parseLocalpiArgs(["--thinking-phase-output-cap", "8000"]).thinkingPhaseOutputCap).toBe(
      8000
    );
    delete process.env["LOCALPI_THINKING_PHASE_OUTPUT_CAP"];
    expect(usage()).toContain("--thinking-phase-output-cap <n>");
  });

  it("defaults the provider API key to local", () => {
    delete process.env["LOCALPI_API_KEY"];
    expect(parseLocalpiArgs([]).apiKey).toBe("local");
  });

  it("takes the provider API key from the flag, then the environment", () => {
    delete process.env["LOCALPI_API_KEY"];
    expect(parseLocalpiArgs(["--api-key", "${LOCALPI_TEST_KEY}"]).apiKey).toBe(
      "${LOCALPI_TEST_KEY}"
    );
    process.env["LOCALPI_API_KEY"] = "${LOCALPI_ENV_KEY}";
    expect(parseLocalpiArgs([]).apiKey).toBe("${LOCALPI_ENV_KEY}");
    expect(parseLocalpiArgs(["--api-key", "literal-key"]).apiKey).toBe("literal-key");
    delete process.env["LOCALPI_API_KEY"];
    expect(usage()).toContain("--api-key <value>");
  });

  it("reads the thinking budget from the environment", () => {
    process.env["LOCALPI_THINKING_BUDGET"] = "2048";
    expect(parseLocalpiArgs([]).thinkingBudget).toBe(2048);

    delete process.env["LOCALPI_THINKING_BUDGET"];
    expect(parseLocalpiArgs([]).thinkingBudget).toBeUndefined();

    process.env["LOCALPI_THINKING_BUDGET"] = "-1";
    expect(parseLocalpiArgs([]).thinkingBudget).toBe(-1);
    delete process.env["LOCALPI_THINKING_BUDGET"];
  });

  it("parses the thinking budget message and lets an empty value through", () => {
    expect(parseLocalpiArgs(["--thinking-budget-message", "Stop now."]).thinkingBudgetMessage).toBe(
      "Stop now."
    );
    expect(parseLocalpiArgs(["--thinking-budget-message", ""]).thinkingBudgetMessage).toBe("");
    expect(parseLocalpiArgs([]).thinkingBudgetMessage).toBeUndefined();
    expect(usage()).toContain("--thinking-budget-message <text>");
  });

  it("reads the thinking budget message from the environment", () => {
    process.env["LOCALPI_THINKING_BUDGET_MESSAGE"] = "Answer now.";
    expect(parseLocalpiArgs([]).thinkingBudgetMessage).toBe("Answer now.");

    process.env["LOCALPI_THINKING_BUDGET_MESSAGE"] = "";
    expect(parseLocalpiArgs([]).thinkingBudgetMessage).toBe("");

    delete process.env["LOCALPI_THINKING_BUDGET_MESSAGE"];
    expect(parseLocalpiArgs([]).thinkingBudgetMessage).toBeUndefined();
  });

  it("rejects removed final schema flags", () => {
    expect(() => parseLocalpiArgs(["--final-schema", "schema.json"])).toThrow(
      "was removed from localpi"
    );
    expect(() => parseLocalpiArgs(["--schema", "schema.json"])).toThrow("was removed from localpi");
  });

  it("turns -h and --help into a single forwarded help flag", () => {
    expect(parseLocalpiArgs(["-h"]).forwardedArgs).toEqual(["--help"]);
    expect(parseLocalpiArgs(["--help", "-p", "ignored"]).forwardedArgs).toEqual(["--help"]);
  });

  it("parses boolean command flags", () => {
    expect(parseLocalpiArgs(["--status"]).status).toBe(true);
    expect(parseLocalpiArgs(["--stop"]).stop).toBe(true);
    expect(parseLocalpiArgs(["--list"]).list).toBe(true);
    expect(parseLocalpiArgs(["--demo"]).demo).toBe(true);
    expect(parseLocalpiArgs(["--demo"]).demoFromCli).toBe(true);
    expect(parseLocalpiArgs(["--acp"]).acp).toBe(true);
    expect(parseLocalpiArgs(["--acp"]).acpFromCli).toBe(true);
  });

  it("tells an environment-set ACP mode apart from the flag", () => {
    const previous = process.env["LOCALPI_ACP"];
    process.env["LOCALPI_ACP"] = "1";
    try {
      const fromEnvironment = parseLocalpiArgs([]);
      expect(fromEnvironment.acp).toBe(true);
      expect(fromEnvironment.acpFromCli).toBe(false);
      const fromCli = parseLocalpiArgs(["--acp"]);
      expect(fromCli.acp).toBe(true);
      expect(fromCli.acpFromCli).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env["LOCALPI_ACP"];
      } else {
        process.env["LOCALPI_ACP"] = previous;
      }
    }
  });

  it("parses every value flag", () => {
    const options = parseLocalpiArgs([
      "--model",
      "custom",
      "--provider",
      "vllm",
      "--provider-id",
      "my-provider",
      "--providers-file",
      "/tmp/localpi-providers.json",
      "--model-profile",
      "/tmp/local-model-profile.json",
      "--model-reasoning",
      "true",
      "--model-thinking-format",
      "qwen-chat-template",
      "--state-dir",
      "/tmp/localpi-state",
      "--session-dir",
      "/tmp/localpi-sessions",
      "--pi-command",
      "my-pi",
      "--context-window",
      "4096",
      "--max-tokens",
      "2048",
      "--continue-on-truncation",
      "3",
      "--timeout-ms",
      "1500",
      "--server-command",
      "/opt/bin/llama-server",
      "--host",
      "0.0.0.0",
      "--gpu-layers",
      "0",
      "--parallel",
      "2",
      "--chat-template",
      "/tmp/template.jinja",
      "--tools",
      "read,bash",
      "--demo-initial-prompt",
      "story",
      "--demo-followup-prompt",
      "again",
      "--demo-initial-prompt-file",
      "/tmp/initial.txt",
      "--demo-followup-prompt-file",
      "/tmp/followup.txt"
    ]);
    expect(options).toMatchObject({
      model: "custom",
      provider: "vllm",
      customProviderId: "my-provider",
      providersFile: "/tmp/localpi-providers.json",
      modelProfileFile: "/tmp/local-model-profile.json",
      modelReasoning: true,
      modelThinkingFormat: "qwen-chat-template",
      stateDir: "/tmp/localpi-state",
      sessionDir: "/tmp/localpi-sessions",
      piCommand: ["my-pi"],
      contextWindow: 4096,
      maxTokens: 2048,
      continueOnTruncation: 3,
      timeoutMs: 1500,
      serverCommand: "/opt/bin/llama-server",
      host: "0.0.0.0",
      gpuLayers: 0,
      parallel: 2,
      chatTemplate: "/tmp/template.jinja",
      tools: "read,bash",
      demoInitialPrompt: "story",
      demoFollowupPrompt: "again",
      demoInitialPromptFile: "/tmp/initial.txt",
      demoFollowupPromptFile: "/tmp/followup.txt"
    });
    expect(parseLocalpiArgs(["--llama-server", "/opt/bin/other"]).serverCommand).toBe(
      "/opt/bin/other"
    );
  });

  it("rejects malformed flag values", () => {
    expect(() => parseLocalpiArgs(["--model"])).toThrow("--model requires a value");
    expect(() => parseLocalpiArgs(["--port", "0"])).toThrow("expected a positive integer, got 0");
    expect(() => parseLocalpiArgs(["--gpu-layers", "-1"])).toThrow(
      "expected a non-negative integer, got -1"
    );
    expect(() => parseLocalpiArgs(["--continue-on-truncation", "0"])).toThrow(
      "expected a positive integer, got 0"
    );
    expect(() => parseLocalpiArgs(["--runtime", "banana"])).toThrow("unknown runtime banana");
  });

  it("documents the supported flags in usage output", () => {
    const text = usage();
    expect(text).toContain("localpi [localpi options] [pi options/messages]");
    expect(text).toContain("--runtime <kind>");
    expect(text).toContain("--thinking <level>");
    expect(text).toContain("--skills <mode>");
    expect(text).toContain("--continue-on-truncation <n>");
    expect(text).toContain("--stop-thinking-key <key>");
    expect(text).toContain("LOCALPI_STOP_THINKING_KEY");
    expect(text).toContain("--stop-thinking-delay <seconds>");
    expect(text).toContain("--web ");
    expect(text).toContain("--web-host <host>");
    expect(text).toContain("--demo");
  });
});

describe("localpi environment defaults", () => {
  const names = [
    "LOCALPI_BASE_URL",
    "LOCALPI_CONTEXT_WINDOW",
    "LOCALPI_APPROVAL",
    "LOCALPI_TOKEN_STATUS",
    "LOCALPI_STATS",
    "LOCALPI_SKILLS",
    "LOCALPI_MODEL",
    "LOCALPI_PROVIDER",
    "LOCALPI_PROVIDERS_FILE",
    "LOCALPI_MODEL_PROFILE",
    "LOCALPI_MODEL_REASONING",
    "LOCALPI_MODEL_THINKING_FORMAT",
    "LOCALPAGER_AGENT_PROFILE",
    "LOCALPAGER_AGENT_REASONING",
    "LOCALPAGER_AGENT_THINKING_FORMAT",
    "LOCALPI_SESSION_DIR",
    "LOCALPI_THINKING",
    "LOCALPI_DEMO",
    "LOCALPI_DEMO_INITIAL_PROMPT",
    "LOCALPI_DEMO_FOLLOWUP_PROMPT",
    "LOCALPI_DEMO_INITIAL_PROMPT_FILE",
    "LOCALPI_DEMO_FOLLOWUP_PROMPT_FILE",
    "LOCALPI_CONTINUE_ON_TRUNCATION",
    "LOCALPI_STOP_THINKING_KEY",
    "LOCALPI_STOP_THINKING_DELAY",
    "LOCALPI_WEB",
    "LOCALPI_WEB_PORT",
    "LOCALPI_WEB_OPEN",
    "LOCALPI_WEB_HOST",
    "LOCALPI_WEB_ALLOWED_HOSTS",
    "LOCALPI_WEB_THEME",
    "LOCALPI_TUI_MODE"
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));

  afterEach(() => {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
  });

  it("reads the TUI mode and the stop thinking key from the environment", () => {
    expect(parseLocalpiArgs([]).tuiMode).toBe("fullscreen");
    process.env["LOCALPI_TUI_MODE"] = "regular";
    process.env["LOCALPI_STOP_THINKING_KEY"] = "off";
    const options = parseLocalpiArgs([]);
    expect(options.tuiMode).toBe("regular");
    expect(options.stopThinkingKey).toBeUndefined();
    expect(parseLocalpiArgs(["--stop-thinking-key", "alt+s"]).stopThinkingKey).toBe("alt+s");

    process.env["LOCALPI_STOP_THINKING_DELAY"] = "10";
    expect(parseLocalpiArgs([]).stopThinkingDelay).toBe(10);
    expect(parseLocalpiArgs(["--stop-thinking-delay", "1"]).stopThinkingDelay).toBe(1);

    process.env["LOCALPI_TUI_MODE"] = "tiny";
    expect(() => parseLocalpiArgs([])).toThrow(
      "unknown TUI mode tiny; expected regular or fullscreen"
    );
  });

  it("reads the web mode options from the environment", () => {
    process.env["LOCALPI_WEB"] = "1";
    process.env["LOCALPI_WEB_PORT"] = "9000";
    process.env["LOCALPI_WEB_OPEN"] = "0";
    process.env["LOCALPI_WEB_HOST"] = "100.64.0.2";
    process.env["LOCALPI_WEB_ALLOWED_HOSTS"] = "box";
    process.env["LOCALPI_WEB_THEME"] = "mocha";
    expect(parseLocalpiArgs([])).toMatchObject({
      web: true,
      webPort: 9000,
      webOpen: false,
      webHost: "100.64.0.2",
      webAllowedHosts: ["box"],
      webTheme: "mocha"
    });
  });

  it("reads defaults from LOCALPI_* environment variables", () => {
    process.env["LOCALPI_BASE_URL"] = "http://127.0.0.1:9999/v1/";
    process.env["LOCALPI_CONTEXT_WINDOW"] = "16384";
    process.env["LOCALPI_CONTINUE_ON_TRUNCATION"] = "2";
    process.env["LOCALPI_APPROVAL"] = "no";
    process.env["LOCALPI_TOKEN_STATUS"] = "1";
    process.env["LOCALPI_MODEL"] = "env-model";
    process.env["LOCALPI_PROVIDER"] = "env-provider";
    process.env["LOCALPI_PROVIDERS_FILE"] = "/tmp/env-providers.json";
    process.env["LOCALPI_MODEL_PROFILE"] = "/tmp/env-profile.json";
    process.env["LOCALPI_MODEL_REASONING"] = "yes";
    process.env["LOCALPI_MODEL_THINKING_FORMAT"] = "deepseek";
    process.env["LOCALPI_SESSION_DIR"] = "/tmp/localpi-env-sessions";
    process.env["LOCALPI_THINKING"] = "medium";
    process.env["LOCALPI_DEMO"] = "true";
    process.env["LOCALPI_DEMO_INITIAL_PROMPT"] = "env story";
    process.env["LOCALPI_DEMO_FOLLOWUP_PROMPT"] = "env again";
    process.env["LOCALPI_DEMO_INITIAL_PROMPT_FILE"] = "/tmp/env-initial.txt";
    process.env["LOCALPI_DEMO_FOLLOWUP_PROMPT_FILE"] = "/tmp/env-followup.txt";

    expect(parseLocalpiArgs([])).toMatchObject({
      baseUrl: "http://127.0.0.1:9999/v1",
      contextWindow: 16384,
      continueOnTruncation: 2,
      approval: false,
      stats: "full",
      model: "env-model",
      provider: "env-provider",
      providersFile: "/tmp/env-providers.json",
      modelProfileFile: "/tmp/env-profile.json",
      modelReasoning: true,
      modelThinkingFormat: "deepseek",
      sessionDir: "/tmp/localpi-env-sessions",
      thinking: "medium",
      demo: true,
      demoFromCli: false,
      demoInitialPrompt: "env story",
      demoFollowupPrompt: "env again",
      demoInitialPromptFile: "/tmp/env-initial.txt",
      demoFollowupPromptFile: "/tmp/env-followup.txt"
    });
  });

  it("treats a zero continuation limit as off and rejects a bad one", () => {
    process.env["LOCALPI_CONTINUE_ON_TRUNCATION"] = "0";
    expect(parseLocalpiArgs([]).continueOnTruncation).toBe(0);

    process.env["LOCALPI_CONTINUE_ON_TRUNCATION"] = "2";
    expect(parseLocalpiArgs(["--continue-on-truncation", "5"]).continueOnTruncation).toBe(5);

    process.env["LOCALPI_CONTINUE_ON_TRUNCATION"] = "many";
    expect(() => parseLocalpiArgs([])).toThrow(
      "LOCALPI_CONTINUE_ON_TRUNCATION must be a nonnegative integer, got many"
    );
  });

  it("accepts LocalPager agent capability profile environment fallbacks", () => {
    process.env["LOCALPAGER_AGENT_PROFILE"] = "/tmp/localpager-profile.json";
    process.env["LOCALPAGER_AGENT_REASONING"] = "true";
    process.env["LOCALPAGER_AGENT_THINKING_FORMAT"] = "qwen-chat-template";

    expect(parseLocalpiArgs([])).toMatchObject({
      modelProfileFile: "/tmp/localpager-profile.json",
      modelReasoning: true,
      modelThinkingFormat: "qwen-chat-template"
    });
  });

  it("reads the stats mode from the environment", () => {
    process.env["LOCALPI_STATS"] = "line";
    expect(parseLocalpiArgs([]).stats).toBe("line");

    delete process.env["LOCALPI_STATS"];
    process.env["LOCALPI_TOKEN_STATUS"] = "0";
    expect(parseLocalpiArgs([]).stats).toBe("off");
    expect(parseLocalpiArgs(["--stats", "full"]).stats).toBe("full");
  });

  it("reads the skills mode from the environment", () => {
    process.env["LOCALPI_SKILLS"] = "ambient";
    expect(parseLocalpiArgs([]).skills).toBe("ambient");

    delete process.env["LOCALPI_SKILLS"];
    expect(parseLocalpiArgs([]).skills).toBe("own");
    expect(parseLocalpiArgs(["--skills", "off"]).skills).toBe("off");
  });

  it("defaults thinking to medium when LOCALPI_THINKING is not set", () => {
    delete process.env["LOCALPI_THINKING"];
    expect(parseLocalpiArgs([])).toMatchObject({
      thinking: "medium"
    });
  });

  it("rejects non boolean-like environment toggles", () => {
    process.env["LOCALPI_APPROVAL"] = "maybe";
    expect(() => parseLocalpiArgs([])).toThrow("LOCALPI_APPROVAL must be boolean-like, got maybe");
  });

  it("lets explicit demo flags override environment prompt values", () => {
    process.env["LOCALPI_DEMO_INITIAL_PROMPT"] = "env story";
    process.env["LOCALPI_DEMO_FOLLOWUP_PROMPT"] = "env again";
    process.env["LOCALPI_DEMO_INITIAL_PROMPT_FILE"] = "/tmp/env-initial.txt";
    process.env["LOCALPI_DEMO_FOLLOWUP_PROMPT_FILE"] = "/tmp/env-followup.txt";
    expect(
      parseLocalpiArgs([
        "--demo-initial-prompt",
        "cli story",
        "--demo-followup-prompt",
        "cli again"
      ])
    ).toMatchObject({
      demoInitialPrompt: "cli story",
      demoFollowupPrompt: "cli again",
      demoInitialPromptFile: undefined,
      demoFollowupPromptFile: undefined
    });
  });

  it("splits the pi launch command and keeps quoted arguments", () => {
    expect(parsePiCommand("npx -y @earendil-works/pi-coding-agent@latest")).toEqual([
      "npx",
      "-y",
      "@earendil-works/pi-coding-agent@latest"
    ]);
    expect(parsePiCommand('"/opt/pi bin/pi" --model "local model"')).toEqual([
      "/opt/pi bin/pi",
      "--model",
      "local model"
    ]);
    expect(parsePiCommand("'/opt/pi bin/pi' --model 'local model'")).toEqual([
      "/opt/pi bin/pi",
      "--model",
      "local model"
    ]);
    expect(() => parsePiCommand("   ")).toThrow("must not be empty");
    expect(parsePiCommand('"unclosed')).toEqual(['"unclosed']);
  });

  it("keeps explicit demo prompt files ahead of explicit demo prompt text", () => {
    expect(
      parseLocalpiArgs([
        "--demo-initial-prompt-file",
        "/tmp/cli-initial.txt",
        "--demo-initial-prompt",
        "cli story",
        "--demo-followup-prompt-file",
        "/tmp/cli-followup.txt",
        "--demo-followup-prompt",
        "cli again"
      ])
    ).toMatchObject({
      demoInitialPrompt: "cli story",
      demoInitialPromptFile: "/tmp/cli-initial.txt",
      demoFollowupPrompt: "cli again",
      demoFollowupPromptFile: "/tmp/cli-followup.txt"
    });
  });
});
