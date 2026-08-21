import { Value, ValueErrorType } from "@sinclair/typebox/value";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import { loadDotEnv, type EnvLoadOptions } from "./env.js";
import { AppConfigSchema, type AppConfig } from "./schema.js";
import { registerSecret, resetRedactionRegistry } from "./redaction.js";
import { configureAgentTimezone } from "../time/index.js";

type PlainObject = Record<string, unknown>;

const SECRET_KEY_RE = /(api[_-]?key|token|password|secret|access[_-]?token)/i;

function isPlainObject(value: unknown): value is PlainObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Merge parsed config files in ascending filename order, each file **deep-merged
 * OVER** the accumulated result: nested tables merge recursively, while arrays and
 * scalars from the later (higher-priority) file replace wholesale (`deepMergeOver`).
 * This is what makes `00-defaults.toml` behave as real defaults — a partial
 * `[agent.sessions]` in `90-local.toml` overrides only the fields it sets and
 * inherits every sibling it omits (e.g. the `resume`/`followup` sub-tables), rather
 * than the whole `agent` subtree being dropped. (Previously a shallow `Object.assign`
 * by top-level key wholesale-replaced each top-level table — the silent
 * default-drop foot-gun this replaces.)
 */
export function mergeConfigLayers(configs: PlainObject[]): PlainObject {
  return configs.reduce<PlainObject>((acc, cfg) => deepMergeOver(acc, cfg), {});
}

/**
 * Deep-merge `child` over `base` (spec MODEL-FALLBACK §2.1 model inheritance):
 * nested plain objects merge recursively, arrays and scalars from `child` replace
 * `base` wholesale. Neither input is mutated. "Child fields win, everything else
 * inherited."
 */
function deepMergeOver(base: PlainObject, child: PlainObject): PlainObject {
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(child)) {
    const prior = out[key];
    if (isPlainObject(prior) && isPlainObject(value)) {
      out[key] = deepMergeOver(prior, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Resolve `[models.*].inherits` (spec MODEL-FALLBACK §2.1) IN PLACE on the merged
 * config, BEFORE schema validation — a virtual model omits the required fields it
 * inherits, so it must be filled in before TypeBox sees it. For each model that
 * declares `inherits`, deep-merge the named parent UNDER it (transitively).
 * Cycles, unknown parents, and a non-object model block fail fast here. The
 * resolved blocks have `inherits` stripped, so they validate as plain real models.
 */
function resolveModelInheritance(merged: PlainObject): void {
  const models = merged.models;
  if (!isPlainObject(models)) return; // absent/malformed → schema validation reports it
  const resolved = new Map<string, PlainObject>();
  const resolving = new Set<string>();

  const resolve = (name: string): PlainObject => {
    const cached = resolved.get(name);
    if (cached) return cached;
    const raw = models[name];
    if (!isPlainObject(raw)) {
      throw new Error(`Invalid config: model "${name}" is not a table`);
    }
    const parentName = raw.inherits;
    if (parentName === undefined) {
      const own = { ...raw };
      resolved.set(name, own);
      return own;
    }
    if (typeof parentName !== "string" || parentName.length === 0) {
      throw new Error(`Invalid config: model "${name}".inherits must be a model name`);
    }
    if (!(parentName in models)) {
      throw new Error(`Invalid config: model "${name}" inherits unknown model "${parentName}"`);
    }
    if (resolving.has(name)) {
      throw new Error(
        `Invalid config: model inheritance cycle through "${name}" (inherits "${parentName}")`,
      );
    }
    resolving.add(name);
    const parent = resolve(parentName);
    resolving.delete(name);
    const out = deepMergeOver(parent, raw);
    delete out.inherits; // resolved away — the block is now a plain real model
    resolved.set(name, out);
    return out;
  };

  for (const name of Object.keys(models)) resolve(name);
  for (const [name, block] of resolved) models[name] = block;
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

/** JSON-pointer path → dotted config path ("/enrichment/fetch_concurrency" → "enrichment.fetch_concurrency"). */
function dottedPath(pointer: string): string {
  return pointer
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .join(".");
}

function formatValidationErrors(config: unknown): string {
  // Validation is strict (schema.ts StrictObject, review issue #29): an unknown
  // key anywhere in the config tree surfaces as an "unexpected property" error.
  // Render those as "<path> is not a recognized config key" so a typo or stale
  // knob names exactly the offending key. Deduped: an intersect (models) can
  // report the same property from both arms.
  const messages = new Set<string>();
  for (const error of Value.Errors(AppConfigSchema, config)) {
    if (error.type === ValueErrorType.ObjectAdditionalProperties) {
      messages.add(`${dottedPath(error.path)} is not a recognized config key`);
    } else {
      messages.add(`${error.path || "/"} ${error.message}`);
    }
  }
  return [...messages].join("; ");
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
  const merged = substituteEnv(mergeConfigLayers(parsed), missingEnv);
  if (missingEnv.size > 0) {
    throw new Error(`Missing environment variables referenced by config: ${[...missingEnv].sort().join(", ")}`);
  }
  // Resolve model inheritance (spec MODEL-FALLBACK §2.1) before structural
  // validation — virtual models omit the required fields they inherit.
  resolveModelInheritance(merged as PlainObject);
  if (!Value.Check(AppConfigSchema, merged)) {
    throw new Error(`Invalid config: ${formatValidationErrors(merged)}`);
  }

  const config = Value.Decode(AppConfigSchema, merged);
  validateConfig(config);
  resetRedactionRegistry();
  registerSecretsByKey(config);
  // Establish the agent's timezone (and set process.env.TZ) as part of config
  // load — before the provider, workers, or sandbox start. Throws on an invalid
  // zone (fail-fast), mirroring the redaction-registry wiring above.
  configureAgentTimezone(config.agent.timezone ?? "UTC");
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

  // Sandbox workspace_mount is a container-absolute path (e.g. /workspace).
  // A relative value would silently break the bind mount and cwd mapping.
  const sandbox = config.sandbox;
  if (sandbox?.enabled && !sandbox.workspace_mount.startsWith("/")) {
    throw new Error(
      `Invalid config: sandbox.workspace_mount must be an absolute path (got "${sandbox.workspace_mount}").`,
    );
  }

  // Browser backend (parity with the console-auth guard above). The schema's
  // `minLength: 1` rejects an empty auth_token, but a whitespace-only value
  // (e.g. `${BROWSER_AUTH_TOKEN}` expanding to " ") would slip through. When the
  // browser is enabled, a present token must be non-blank; an ABSENT token means
  // the Manager runs token-less (localhost isolation) and is left untouched.
  const browser = config.browser;
  if (browser?.enabled && browser.auth_token !== undefined && browser.auth_token.trim() === "") {
    throw new Error(
      "Invalid config: browser.auth_token is present but blank — set a non-empty " +
        "token (matching the Manager's AUTH_TOKEN) or remove the key to connect to " +
        "a token-less Manager.",
    );
  }
  // manager_url must be an absolute http(s) URL the harness can connect to.
  if (browser?.enabled) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(browser.manager_url);
    } catch {
      parsed = undefined;
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      throw new Error(
        `Invalid config: browser.manager_url must be an absolute http(s) URL (got "${browser.manager_url}").`,
      );
    }
  }

  // Budget-driven eager condensation (spec SUMMARY-LAYER-BUDGET §7).
  const tiers = config.context.tiers;
  const summaryTarget = tiers.summary_target_tokens ?? 0;
  const summaryMax = tiers.summary_max_tokens ?? 0;
  const SUMMARY_TOKEN_RANGE_MIN = 2000;
  const SUMMARY_TOKEN_RANGE_MAX = 200_000;
  if (summaryTarget !== 0 && (summaryTarget < SUMMARY_TOKEN_RANGE_MIN || summaryTarget > SUMMARY_TOKEN_RANGE_MAX)) {
    throw new Error(
      `Invalid config: context.tiers.summary_target_tokens must be 0 (disabled) or in [${SUMMARY_TOKEN_RANGE_MIN}, ${SUMMARY_TOKEN_RANGE_MAX}] (got ${summaryTarget}).`,
    );
  }
  if (summaryMax !== 0 && (summaryMax < SUMMARY_TOKEN_RANGE_MIN || summaryMax > SUMMARY_TOKEN_RANGE_MAX)) {
    throw new Error(
      `Invalid config: context.tiers.summary_max_tokens must be 0 (same as target) or in [${SUMMARY_TOKEN_RANGE_MIN}, ${SUMMARY_TOKEN_RANGE_MAX}] (got ${summaryMax}).`,
    );
  }
  if (summaryMax !== 0 && summaryTarget !== 0 && summaryMax < summaryTarget) {
    throw new Error(
      `Invalid config: context.tiers.summary_max_tokens (${summaryMax}) must be ≥ summary_target_tokens (${summaryTarget}).`,
    );
  }
  const summarization = config.summarization;
  if (summarization) {
    const fanout = summarization.condense_fanout ?? 5;
    const minChildren = summarization.eager_condense_min_children;
    const maxChildren = summarization.eager_absorb_max_children;
    if (minChildren !== undefined && minChildren > fanout) {
      throw new Error(
        `Invalid config: summarization.eager_condense_min_children (${minChildren}) must be ≤ condense_fanout (${fanout}).`,
      );
    }
    if (maxChildren !== undefined && maxChildren !== 0) {
      if (maxChildren < fanout) {
        throw new Error(
          `Invalid config: summarization.eager_absorb_max_children (${maxChildren}) must be ≥ condense_fanout (${fanout}) or 0 (auto).`,
        );
      }
      if (maxChildren > 4 * fanout) {
        throw new Error(
          `Invalid config: summarization.eager_absorb_max_children (${maxChildren}) must be ≤ 4 × condense_fanout (${4 * fanout}).`,
        );
      }
    }
  }
}
