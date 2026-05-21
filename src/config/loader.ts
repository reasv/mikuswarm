import { Value } from "@sinclair/typebox/value";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import { AppConfigSchema, type AppConfig } from "./schema.js";
import { registerSecret } from "./redaction.js";

type PlainObject = Record<string, unknown>;

const SECRET_KEY_RE = /(api[_-]?key|token|password|secret|access[_-]?token)/i;
const ENV_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function isPlainObject(value: unknown): value is PlainObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shallowMergeByTopLevel(configs: PlainObject[]): PlainObject {
  return Object.assign({}, ...configs);
}

function substituteEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_RE, (_, name: string) => process.env[name] ?? "");
  }
  if (Array.isArray(value)) {
    return value.map((child) => substituteEnv(child));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, substituteEnv(child)]),
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

export async function loadConfig(configDir: string): Promise<AppConfig> {
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
    parsed.push(parse(text) as PlainObject);
  }

  const merged = substituteEnv(shallowMergeByTopLevel(parsed));
  registerSecretsByKey(merged);

  if (!Value.Check(AppConfigSchema, merged)) {
    throw new Error(`Invalid config: ${formatValidationErrors(merged)}`);
  }

  const config = Value.Decode(AppConfigSchema, merged);
  return config;
}

