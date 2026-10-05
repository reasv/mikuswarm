/**
 * Code version for the behaviour snapshot (spec REFUSAL-HANDLING §12.4): the
 * package version plus a build revision. Images bake the revision in through the
 * `MIKUSWARM_BUILD_REVISION` build argument (Dockerfile); a development checkout
 * falls back to its git HEAD; anything else is "unknown".
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CodeVersion } from "./snapshot.js";

/** Environment variable carrying the baked build revision. */
export const BUILD_REVISION_ENV = "MIKUSWARM_BUILD_REVISION";

function packageVersion(): string {
  try {
    // src/behaviour/ (tsx) and dist/behaviour/ (image) both sit two levels below the package root.
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function gitHead(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    return /^[0-9a-f]{7,40}$/.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

export interface ResolveCodeVersionOptions {
  env?: NodeJS.ProcessEnv;
  /** Directory to ask git in; default the package root. */
  cwd?: string;
}

export function resolveCodeVersion(options: ResolveCodeVersionOptions = {}): CodeVersion {
  const env = options.env ?? process.env;
  const baked = env[BUILD_REVISION_ENV]?.trim();
  const revision =
    baked && baked !== "unknown"
      ? baked
      : gitHead(options.cwd ?? fileURLToPath(new URL("../../", import.meta.url))) ?? "unknown";
  return { version: packageVersion(), revision };
}
