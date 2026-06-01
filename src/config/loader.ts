import { Value } from "@sinclair/typebox/value";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import { loadDotEnv, type EnvLoadOptions } from "./env.js";
import { AppConfigSchema, type AppConfig } from "./schema.js";
import { registerSecret, resetRedactionRegistry } from "./redaction.js";

type PlainObject = Record<string, unknown>;

const SECRET_KEY_RE = /(api[_-]?key|token|password|secret|access[_-]?token)/i;

function isPlainObject(value: unknown): value is PlainObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shallowMergeByTopLevel(configs: PlainObject[]): PlainObject {
  return Object.assign({}, ...configs);
}

function substituteEnv(value: unknown, missing = new Set<string>()): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const replacement = process.env[name];
      if (replacement === undefined) {
        missing.add(name);
        return "";
      }
      return replacement;
    });
  }
  if (Array.isArray(value)) {
    return value.map((child) => substituteEnv(child, missing));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, substituteEnv(child, missing)]),
    );
  }
  return value;
}

function registerSecretsByKey(value: unknown, pathParts: string[] = []): void {
  if (Array.isArray(value)) {
    for (const child of value) registerSecretsByKey(child, pathParts);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    if (SECRET_KEY_RE.test(key)) registerSecret(child);
    registerSecretsByKey(child, nextPath);
  }
}

function formatValidationErrors(config: unknown): string {
  return [...Value.Errors(AppConfigSchema, config)]
    .map((error) => `${error.path || "/"} ${error.message}`)
    .join("; ");
}

export interface ConfigLoadOptions {
  env?: EnvLoadOptions | false;
}

export async function loadConfig(configDir: string, options: ConfigLoadOptions = {}): Promise<AppConfig> {
  if (options.env !== false) {
    await loadDotEnv(options.env);
  }

  const entries = await readdir(configDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    throw new Error(`No TOML config files found in ${configDir}`);
  }

  const parsed: PlainObject[] = [];
  for (const file of files) {
    const fullPath = path.join(configDir, file);
    const text = await readFile(fullPath, "utf8");
    try {
      parsed.push(parse(text) as PlainObject);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse TOML config ${fullPath}: ${message}`, { cause: error });
    }
  }

  const missingEnv = new Set<string>();
  const merged = substituteEnv(shallowMergeByTopLevel(parsed), missingEnv);
  if (missingEnv.size > 0) {
    throw new Error(`Missing environment variables referenced by config: ${[...missingEnv].sort().join(", ")}`);
  }
  if (!Value.Check(AppConfigSchema, merged)) {
    throw new Error(`Invalid config: ${formatValidationErrors(merged)}`);
  }

  const config = Value.Decode(AppConfigSchema, merged);
  validateConfig(config);
  resetRedactionRegistry();
  registerSecretsByKey(config);
  return config;
}

/**
 * Cross-field, fail-fast checks the TypeBox schema can't express on its own.
 * Runs after structural validation/decoding so all values are present and typed.
 */
function validateConfig(config: AppConfig): void {
  // Observability console auth (issue #5). The schema's `minLength: 1` already
  // rejects an empty `auth_token`, but a whitespace-only value (e.g.
  // `${MIKUSWARM_CONSOLE_TOKEN}` expanding to " ") would slip through and silently
  // open the console to every request. When the server is enabled, a present
  // token must be non-blank. Absent token = auth intentionally disabled (the
  // localhost-operator default) and is left untouched.
  const server = config.observability?.server;
  if (server?.enabled && server.auth_token !== undefined && server.auth_token.trim() === "") {
    throw new Error(
      "Invalid config: observability.server.auth_token is present but blank — " +
        "set a non-empty token or remove the key to run the console without auth " +
        "(localhost-only operator default).",
    );
  }
}
