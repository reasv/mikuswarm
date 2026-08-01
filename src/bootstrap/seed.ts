import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * First-run seeding (ARCHITECTURE.md §4 "First-run seeding").
 *
 * A fresh deploy ships with code + a `templates/` tree but an empty config dir
 * and an empty workspace. These helpers populate those from the templates so the
 * bot can boot, WITHOUT ever clobbering an existing deployment.
 *
 * SAFETY INVARIANT (the single most important property here): every copy is
 * **copy-missing / never-overwrite**. A target file that already exists is left
 * exactly as-is — byte-identical — and the seeding is a strict no-op when all
 * targets are present (the live + current-image case). A live persona file
 * (SOUL.md, etc.) can therefore never be destroyed by a rebuild/restart.
 */

/** Resolve the templates root: env override `MIKUSWARM_TEMPLATES_DIR`, else `<cwd>/templates`. */
export function resolveTemplatesDir(): string {
  const override = process.env.MIKUSWARM_TEMPLATES_DIR;
  if (override && override.trim().length > 0) return path.resolve(override);
  return path.resolve(process.cwd(), "templates");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively copy every file under `srcDir` into `destDir`, creating intermediate
 * directories as needed, but ONLY where the destination path does not already
 * exist. Existing destination files are NEVER overwritten — they are skipped
 * untouched. If `srcDir` does not exist, this is a no-op (no throw). Returns the
 * absolute paths actually created, for logging.
 *
 * This is the safety-critical primitive. It is deliberately conservative: it
 * checks existence per file immediately before copying, and uses `copyFile` with
 * `COPYFILE_EXCL` so the kernel itself refuses to overwrite even under a race
 * (an EEXIST from that flag is treated as "already present" and skipped, not an
 * error).
 */
export async function seedDirMissing(srcDir: string, destDir: string): Promise<string[]> {
  if (!(await pathExists(srcDir))) return [];

  const created: string[] = [];

  async function walk(curSrc: string, curDest: string): Promise<void> {
    const entries = await readdir(curSrc, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(curSrc, entry.name);
      const destPath = path.join(curDest, entry.name);
      if (entry.isDirectory()) {
        await walk(srcPath, destPath);
        continue;
      }
      if (!entry.isFile()) continue; // ignore symlinks/devices/etc. — copy plain files only
      // Skip if the destination already exists. Never overwrite.
      if (await pathExists(destPath)) continue;
      await mkdir(path.dirname(destPath), { recursive: true });
      try {
        // COPYFILE_EXCL: the kernel refuses to overwrite, closing the
        // check-then-copy race. EEXIST here means another writer won → skip.
        await copyFile(srcPath, destPath, fsConstants.COPYFILE_EXCL);
        created.push(destPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
    }
  }

  await walk(srcDir, destDir);
  return created;
}

/**
 * Minimal logger surface — message-first to match the project's `Logger`
 * (src/observability/logger.ts) and `console`. Both `info`/`warn` are optional
 * so a bare `console` or a partial stub satisfies it.
 */
type SeedLogger = {
  info?: (message: string, fields?: Record<string, unknown>) => void;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
};

/**
 * Seed the config directory BEFORE the config loader runs. The loader fail-fasts
 * on a missing/empty config dir, so any seeding must precede it. We cannot read
 * config here, so the templates root comes from the env/default only.
 *
 * Copy-missing:
 *  - `<config>/90-local.toml`   ← `templates/config/90-local.toml`
 *  - `<config>/00-defaults.toml` ← shipped `<cwd>/config/00-defaults.toml`
 *
 * Strict no-op when both already exist (the live + current-image case). Fails
 * SAFE: any unexpected error is logged and swallowed so startup continues — a
 * genuinely-missing required config still fails later in the loader, exactly as
 * it does today.
 */
export async function seedConfigDir(configDir: string, logger?: SeedLogger): Promise<void> {
  try {
    const templatesDir = resolveTemplatesDir();
    await mkdir(configDir, { recursive: true });

    const localSrc = path.join(templatesDir, "config", "90-local.toml");
    const localDest = path.join(configDir, "90-local.toml");
    if ((await pathExists(localSrc)) && !(await pathExists(localDest))) {
      await mkdir(path.dirname(localDest), { recursive: true });
      await copyFileMissing(localSrc, localDest, logger);
    }

    // 00-defaults.toml ships in the repo's own `config/` dir (today's source of
    // truth). Seed it copy-missing so a fresh config dir gets the defaults layer.
    const defaultsSrc = path.join(process.cwd(), "config", "00-defaults.toml");
    const defaultsDest = path.join(configDir, "00-defaults.toml");
    if (
      // Don't copy onto itself when configDir IS the repo's config dir.
      path.resolve(defaultsSrc) !== path.resolve(defaultsDest) &&
      (await pathExists(defaultsSrc)) &&
      !(await pathExists(defaultsDest))
    ) {
      await copyFileMissing(defaultsSrc, defaultsDest, logger);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn?.("config seeding skipped (continuing startup)", { err: message });
  }
}

/** copyFile with COPYFILE_EXCL, EEXIST treated as already-present (no-op). */
async function copyFileMissing(src: string, dest: string, logger?: SeedLogger): Promise<void> {
  try {
    await copyFile(src, dest, fsConstants.COPYFILE_EXCL);
    logger?.info?.("seeded missing file", { src, dest });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
}

/**
 * Seed the workspace AFTER config load (once `workspaceRoot` is known). Only seeds
 * when the workspace is "empty" — defined conservatively as having NEITHER an
 * `AGENTS.md` NOR a `SOUL.md`. This emptiness gate avoids partially seeding into an
 * established workspace; `seedDirMissing` itself still never overwrites, so even if
 * the gate let a populated dir through nothing would be clobbered.
 *
 * Fails SAFE: errors are logged and swallowed (a real workspace problem surfaces
 * later when the agent loads its files).
 */
export async function seedWorkspace(workspaceRoot: string, logger?: SeedLogger): Promise<void> {
  try {
    const hasAgents = await pathExists(path.join(workspaceRoot, "AGENTS.md"));
    const hasSoul = await pathExists(path.join(workspaceRoot, "SOUL.md"));
    if (hasAgents || hasSoul) return; // established workspace → no-op

    const templatesDir = resolveTemplatesDir();
    const src = path.join(templatesDir, "workspace");
    if (!(await pathExists(src))) {
      // The workspace NEEDS seeding (emptiness gate above passed) but the
      // template source is missing — a deployment/packaging problem (e.g. an
      // image built without templates/). Silent no-op here leaves the agent on
      // the fallback prompt with no trace; make it loud.
      logger?.warn?.("workspace needs seeding but templates dir is missing", {
        workspaceRoot,
        templatesDir: src,
      });
      return;
    }
    const created = await seedDirMissing(src, workspaceRoot);
    if (created.length > 0) {
      logger?.info?.("seeded workspace from templates", { count: created.length, workspaceRoot });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn?.("workspace seeding skipped (continuing startup)", { err: message });
  }
}

/**
 * Seed feature-gated skill files AFTER config load, for each feature whose gate is
 * strictly `true`. Copies `templates/features/<feature>/skills/*` into
 * `<workspaceRoot>/skills/` copy-missing — a no-op when the skill dir already
 * exists (its files are present). `enabledFeatures` is the list of feature names
 * (keys of `[features]`) whose flag is on.
 *
 * Fails SAFE: errors are logged and swallowed.
 */
export async function seedFeatureSkills(
  workspaceRoot: string,
  enabledFeatures: readonly string[],
  logger?: SeedLogger,
): Promise<void> {
  try {
    const templatesDir = resolveTemplatesDir();
    const skillsDest = path.join(workspaceRoot, "skills");
    for (const feature of enabledFeatures) {
      const src = path.join(templatesDir, "features", feature, "skills");
      const created = await seedDirMissing(src, skillsDest);
      if (created.length > 0) {
        logger?.info?.("seeded feature skill(s) from templates", { feature, count: created.length });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn?.("feature-skill seeding skipped (continuing startup)", { err: message });
  }
}
