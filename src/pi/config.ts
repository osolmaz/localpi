import { writePiRuntimeConfig } from "pi-factory";
import type { PiRuntimeConfig } from "pi-factory";

import type { LocalpiOptions } from "../localpi/options.js";
import type { RuntimeConnection } from "../localpi/runtime.js";
import { createLocalpiAppDefinition } from "./app.js";

export type RuntimeConfig = PiRuntimeConfig;

export async function writeRuntimeConfig(
  options: LocalpiOptions,
  connection: RuntimeConnection
): Promise<RuntimeConfig> {
  return await writePiRuntimeConfig(createLocalpiAppDefinition(options, connection));
}
