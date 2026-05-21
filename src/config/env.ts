import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

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
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = parseEnvValue(line.slice(eq + 1).trim());
  }
  return values;
}

function parseEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

