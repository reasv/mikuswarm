import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";

export interface EnvLoadOptions {
  cwd?: string;
  envDir?: string;
  envFile?: string;
  override?: boolean;
}

export interface EnvLoadResult {
  path: string;
  loaded: boolean;
  keys: string[];
}

export async function loadDotEnv(options: EnvLoadOptions = {}): Promise<EnvLoadResult> {
  const cwd = options.cwd ?? process.cwd();
  const envDir = options.envDir ?? process.env.MIKUSWARM_AGENT_ENV_DIR ?? cwd;
  const envFile = options.envFile ?? ".env";
  const filePath = path.resolve(envDir, envFile);

  if (!existsSync(filePath)) {
    return { path: filePath, loaded: false, keys: [] };
  }

  const text = await readFile(filePath, "utf8");
  const parsed = parseDotEnv(text);
  const keys: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!options.override && process.env[key] !== undefined) continue;
    process.env[key] = value;
    keys.push(key);
  }
  return { path: filePath, loaded: true, keys };
}

export function parseDotEnv(text: string): Record<string, string> {
  return parseDotenv(text);
}
