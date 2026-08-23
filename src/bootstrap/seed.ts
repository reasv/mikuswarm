import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, open as fsOpen, readdir, readFile, rename, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
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

// ── Ledger-driven workspace template reconciliation (§4b / spec §5) ──────────

/**
 * Minimal ledger interface. seed.ts never imports Storage directly; app.ts wires
 * a concrete implementation from Storage.get/upsertSeedLedgerRow.
 */
export interface SeedLedgerRow {
  agent_name: string;
  rel_path: string;
  source: string;
  origin: "seeded" | "adopted" | "updated";
  template_hash: string;
  created_at: number;
  updated_at: number;
}

/** Per-agent ledger operations injected by the caller (app.ts wires from Storage). */
export interface SeedLedgerOps {
  /** Synchronous read: returns the row or undefined if absent. */
  get(relPath: string): SeedLedgerRow | undefined;
  /** Synchronous read: all rows for this agent (used for unwalked-path detection). */
  list(): SeedLedgerRow[];
  /** Async write through the single-writer queue. */
  upsert(patch: {
    rel_path: string;
    source: string;
    origin: "seeded" | "adopted" | "updated";
    template_hash: string;
  }): Promise<void>;
}

/** One source tree fed to the reconcile: a source-id, template srcDir, and destination dir. */
export interface ReconcileSource {
  /** "workspace" | "feature:<name>" */
  source: string;
  /** Absolute path to the template source directory. */
  srcDir: string;
  /** Absolute path to the destination directory for this source's files. */
  destDir: string;
}

/** Options for {@link reconcileWorkspace}. */
export interface ReconcileOptions {
  updateUnmodified: boolean;
  logger?: SeedLogger & {
    debug?: (message: string, fields?: Record<string, unknown>) => void;
  };
}

/** Compute SHA-256 hex of a file's bytes. */
async function hashFile(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

/** Compute SHA-256 hex of an in-memory buffer. */
function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Write `content` to `destPath` via temp-file + atomic rename.
 * The temp file is placed in the same directory as the destination so the rename
 * is always within the same filesystem (no cross-device rename).
 */
async function atomicWrite(destPath: string, content: Buffer): Promise<void> {
  const dir = path.dirname(destPath);
  const base = path.basename(destPath);
  // Create a temp file in the same directory with a random suffix.
  const tmpPath = path.join(dir, `.${base}.tmp.${Math.random().toString(36).slice(2)}`);
  let fh: ReturnType<typeof fsOpen> extends Promise<infer T> ? T : never;
  try {
    await mkdir(dir, { recursive: true });
    // O_WRONLY | O_CREAT | O_EXCL — exclusive create so we never clobber an
    // existing file before the rename; the random suffix makes collision vanishingly
    // unlikely but we still guard it.
    fh = await fsOpen(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL);
    await fh.writeFile(content);
    await fh.close();
    await rename(tmpPath, destPath);
  } catch (err) {
    // Best-effort cleanup of the temp file on any failure.
    try { await (await fsOpen(tmpPath, "r")).close(); } catch { /* ignore */ }
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(tmpPath);
    } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Ledger-driven per-file reconcile for one agent's workspace (spec §5).
 *
 * For every file in every source tree, applies the six-case algorithm:
 *   1. No row, no local → seed (COPYFILE_EXCL; EEXIST → adopt)
 *   2. No row, local exists → adopt (record silently, never touch content)
 *   3. Row, no local → tombstone (skip; update hash silently if changed)
 *   4. Row, local, template hash unchanged → no-op (the common steady-state)
 *   5. Row, local, template hash changed → hash local:
 *      - local == new template hash → operator already applied it, update row
 *      - local == old template hash AND update_unmodified → safe atomic overwrite
 *      - local == old template hash AND !update_unmodified → drift notice (unmodified)
 *      - otherwise → drift notice (modified)
 *
 * Returns counters for the per-agent summary log line.
 *
 * Does NOT import Storage. The caller (app.ts) wires `ledger` from Storage.
 *
 * Fails SAFE: every per-file error is logged and swallowed; startup continues.
 */
export async function reconcileWorkspace(
  agentName: string,
  sources: ReconcileSource[],
  ledger: SeedLedgerOps,
  opts: ReconcileOptions,
): Promise<{ seeded: number; updated: number; driftNotices: number; tombstonesSkipped: number }> {
  const { updateUnmodified, logger } = opts;
  let seeded = 0;
  let updated = 0;
  let driftNotices = 0;
  let tombstonesSkipped = 0;

  // Track all rel_paths walked in this run (for §5.5 un-walked ledger row detection).
  const walkedRelPaths = new Set<string>();

  for (const src of sources) {
    if (!(await pathExists(src.srcDir))) continue; // missing source tree → skip silently

    // Collect all files in this source tree.
    const files: Array<{ srcPath: string; relPath: string; destPath: string }> = [];
    const walkSource = async (curSrc: string): Promise<void> => {
      let rawEntries: import("node:fs").Dirent[];
      try {
        rawEntries = (await readdir(curSrc, { withFileTypes: true })) as import("node:fs").Dirent[];
      } catch {
        return; // unreadable dir → skip
      }
      for (const entry of rawEntries) {
        const srcPath = path.join(curSrc, entry.name as string);
        if (entry.isDirectory()) {
          await walkSource(srcPath);
          continue;
        }
        if (!entry.isFile()) continue; // ignore symlinks/devices
        // rel_path: posix-style path relative to the destination root.
        const relToSrc = path.relative(src.srcDir, srcPath);
        const relPath = relToSrc.split(path.sep).join("/");
        const destPath = path.join(src.destDir, relToSrc);
        files.push({ srcPath, relPath, destPath });
      }
    };
    await walkSource(src.srcDir);

    for (const { srcPath, relPath, destPath } of files) {
      walkedRelPaths.add(relPath);
      try {
        await reconcileFile({
          agentName,
          relPath,
          srcPath,
          destPath,
          source: src.source,
          ledger,
          updateUnmodified,
          logger,
          counters: { seeded: () => seeded++, updated: () => updated++, driftNotices: () => driftNotices++, tombstonesSkipped: () => tombstonesSkipped++ },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger?.warn?.("workspace reconcile: per-file error (skipping)", { agent: agentName, path: relPath, err: msg });
      }
    }
  }

  // §5.5: detect ledger rows not walked in this run (unshipped / feature-disabled).
  // Log at debug to avoid repeated noise; no deletions ever.
  const allRows = ledger.list();
  for (const row of allRows) {
    if (!walkedRelPaths.has(row.rel_path)) {
      logger?.debug?.("workspace reconcile: ledger row not in any active source tree (unshipped or feature-disabled)", {
        agent: agentName,
        path: row.rel_path,
        source: row.source,
      });
    }
  }

  return { seeded, updated, driftNotices, tombstonesSkipped };
}

interface ReconcileFileArgs {
  agentName: string;
  relPath: string;
  srcPath: string;
  destPath: string;
  source: string;
  ledger: SeedLedgerOps;
  updateUnmodified: boolean;
  logger?: ReconcileOptions["logger"];
  counters: {
    seeded: () => void;
    updated: () => void;
    driftNotices: () => void;
    tombstonesSkipped: () => void;
  };
}

async function reconcileFile(args: ReconcileFileArgs): Promise<void> {
  const { agentName, relPath, srcPath, destPath, source, ledger, updateUnmodified, logger, counters } = args;

  const row = ledger.get(relPath);
  const localExists = await pathExists(destPath);

  // Read template content and compute hash (needed for most cases).
  const templateBytes = await readFile(srcPath);
  const templateHash = hashBytes(templateBytes);

  const now = Date.now();

  if (!row) {
    if (!localExists) {
      // Case 1: No row, no local file → seed.
      await mkdir(path.dirname(destPath), { recursive: true });
      try {
        await copyFile(srcPath, destPath, fsConstants.COPYFILE_EXCL);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          // Race: file appeared between stat and copy → adopt (case 2 semantics).
          await ledger.upsert({ rel_path: relPath, source, origin: "adopted", template_hash: templateHash });
          logger?.debug?.("workspace reconcile: adopted (race-created) file", { agent: agentName, path: relPath, source });
          return;
        }
        throw err;
      }
      await ledger.upsert({ rel_path: relPath, source, origin: "seeded", template_hash: templateHash });
      counters.seeded();
      logger?.info?.("workspace reconcile: seeded new template file", { agent: agentName, path: relPath, source });
    } else {
      // Case 2: No row, local file exists → adopt silently.
      await ledger.upsert({ rel_path: relPath, source, origin: "adopted", template_hash: templateHash });
      logger?.debug?.("workspace reconcile: adopted pre-existing file", { agent: agentName, path: relPath, source });
    }
  } else {
    // row is defined here (SeedLedgerRow).
    if (!localExists) {
      // Case 3: Row, no local file → tombstone. Skip; update hash if changed.
      counters.tombstonesSkipped();
      if (templateHash !== row.template_hash) {
        await ledger.upsert({ rel_path: relPath, source, origin: row.origin, template_hash: templateHash });
        logger?.debug?.("workspace reconcile: tombstone hash updated (template changed upstream)", { agent: agentName, path: relPath, source });
      } else {
        logger?.debug?.("workspace reconcile: tombstone skipped", { agent: agentName, path: relPath, source });
      }
    } else {
      // row && localExists — cases 4 and 5.
      if (templateHash === row.template_hash) {
        // Case 4: Template unchanged → no-op (overwhelmingly common steady state).
        // Do NOT hash the local file: steady-state cost is one stat per template file.
        return;
      }

      // Case 5: Template changed upstream. Now hash the local file.
      const localHash = await hashFile(destPath);

      if (localHash === templateHash) {
        // 5a: Operator already applied the new version by hand → update row silently.
        await ledger.upsert({ rel_path: relPath, source, origin: row.origin, template_hash: templateHash });
        logger?.debug?.("workspace reconcile: local already matches new template (pre-applied)", { agent: agentName, path: relPath });
      } else if (localHash === row.template_hash) {
        // 5b: Local still byte-identical to old ledger version → provably never locally edited.
        if (updateUnmodified) {
          // Safe update: write via temp-file + atomic rename.
          await atomicWrite(destPath, templateBytes);
          await ledger.upsert({ rel_path: relPath, source, origin: "updated", template_hash: templateHash });
          counters.updated();
          logger?.info?.("workspace reconcile: updated unmodified template file", {
            agent: agentName,
            path: relPath,
            source,
            old_hash: row.template_hash,
            new_hash: templateHash,
          });
        } else {
          // Drift notice, tagged unmodified — update ledger hash so we emit this once.
          await ledger.upsert({ rel_path: relPath, source, origin: row.origin, template_hash: templateHash });
          counters.driftNotices();
          logger?.info?.("workspace reconcile: template file changed upstream (local unmodified; safe to copy)", {
            agent: agentName,
            path: relPath,
            source,
            local: "unmodified",
            old_hash: row.template_hash,
            new_hash: templateHash,
            hint: "git show <old_rev>:templates/..., then copy the new template version",
          });
        }
      } else {
        // 5c: Local modified — drift notice. Update ledger hash so we emit once per upstream change.
        await ledger.upsert({ rel_path: relPath, source, origin: row.origin, template_hash: templateHash });
        counters.driftNotices();
        logger?.info?.("workspace reconcile: template file changed upstream (local modified; manual merge needed)", {
          agent: agentName,
          path: relPath,
          source,
          local: "modified",
          old_hash: row.template_hash,
          new_hash: templateHash,
          hint: "git show <old_rev>:templates/... for base; git merge-file <local> <base> templates/<path>",
        });
      }
    }
  }
}
