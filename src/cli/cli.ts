import { errorMessage, fail, ok, type CommandResult } from "../common/result.js";
import { parseLocalagentArgs, usage } from "../localagent/options.js";
import { resolveLocalModel } from "../llm/openai.js";
import { writeRuntimeConfig } from "../pi/config.js";
import { createLaunchPlan, execLaunchPlan } from "../pi/launch.js";

export async function run(args: readonly string[]): Promise<CommandResult> {
  try {
    const options = parseLocalagentArgs(args);
    if (options.forwardedArgs.length === 1 && options.forwardedArgs[0] === "--help") {
      return ok(usage());
    }

    const resolved = await resolveLocalModel(options.baseUrl, options.model, options.timeoutMs);
    const runtimeConfig = await writeRuntimeConfig(options, resolved.model);

    if (options.status) {
      return ok(
        [
          `base url: ${options.baseUrl}`,
          `model: ${resolved.model}`,
          `available models: ${resolved.availableModels.join(", ")}`,
          `provider id: ${options.providerId}`,
          `pi config dir: ${runtimeConfig.configDir}`,
          `session dir: ${options.sessionDir}`,
          `pi command: ${options.piCommand}`
        ].join("\n") + "\n"
      );
    }

    const plan = await createLaunchPlan(options, runtimeConfig, resolved.model);
    return { code: await execLaunchPlan(plan), stdout: "", stderr: "" };
  } catch (error) {
    return fail(`localagent: ${errorMessage(error)}`);
  }
}
