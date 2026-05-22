import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";

export interface EnvLoadResult {
  loadedFrom: string[];
  values: Record<string, string>;
}

export interface EnvLoadOptions {
  pluginDir: string;
}

export function loadPluginEnv(opts: EnvLoadOptions): EnvLoadResult {
  const paths = [
    join(opts.pluginDir, "../../.env"),
    join(opts.pluginDir, "..", ".env"),
    join(opts.pluginDir, ".env"),
    join(homedir(), ".config/opencode/telegram-remote/.env"),
  ];
  const loadedFrom: string[] = [];
  const values: Record<string, string> = {};

  for (const envPath of paths) {
    if (!existsSync(envPath)) continue;
    const result = dotenv.config({ path: envPath, override: false });
    if (result.parsed) {
      loadedFrom.push(envPath);
      for (const [key, value] of Object.entries(result.parsed)) {
        if (!(key in values)) values[key] = value;
      }
    }
  }

  return { loadedFrom, values };
}
