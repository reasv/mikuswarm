/**
 * Tests for the ledger-driven workspace template reconciliation engine.
 * Spec: spec/WORKSPACE-TEMPLATE-RECONCILIATION.md §10
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  reconcileWorkspace,
  seedDirMissing,
  type ReconcileSource,
  type SeedLedgerOps,
  type SeedLedgerRow,
} from "../src/bootstrap/seed.js";
import { Storage } from "../src/storage/index.js";

// ---------------------------------------------------------------------------
// In-memory ledger stub
// ---------------------------------------------------------------------------

class MemLedger implements SeedLedgerOps {
  readonly rows = new Map<string, SeedLedgerRow>();

  constructor(
    private readonly agentName: string,
    private readonly now = Date.now(),
  ) {}

  get(relPath: string): SeedLedgerRow | undefined {
    return this.rows.get(relPath);
  }

  list(): SeedLedgerRow[] {
    return [...this.rows.values()];
  }

  async upsert(patch: {
    rel_path: string;
    source: string;
    origin: "seeded" | "adopted" | "updated";
    template_hash: string;
  }): Promise<void> {
    const existing = this.rows.get(patch.rel_path);
    this.rows.set(patch.rel_path, {
      agent_name: this.agentName,
      rel_path: patch.rel_path,
      source: patch.source,
      origin: patch.origin,
      template_hash: patch.template_hash,
      created_at: existing?.created_at ?? this.now,
      updated_at: this.now,
    });
  }
}

// ---------------------------------------------------------------------------
// Capturing logger stub
// ---------------------------------------------------------------------------

interface LogEntry {
  level: "debug" | "info" | "warn";
  message: string;
  fields?: Record<string, unknown>;
}

function makeCapturingLogger(): {
  logger: NonNullable<Parameters<typeof reconcileWorkspace>[3]["logger"]>;
  entries: LogEntry[];
} {
  const entries: LogEntry[] = [];
  const logger = {
    debug(message: string, fields?: Record<string, unknown>) {
      entries.push({ level: "debug", message, fields });
    },
    info(message: string, fields?: Record<string, unknown>) {
      entries.push({ level: "info", message, fields });
    },
    warn(message: string, fields?: Record<string, unknown>) {
      entries.push({ level: "warn", message, fields });
    },
  };
  return { logger, entries };
}

// ---------------------------------------------------------------------------
// Temp dir helper
// ---------------------------------------------------------------------------

async function withTmpDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-seed-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Helper: read directory tree as a map of relPath → content
// ---------------------------------------------------------------------------

async function readTree(
  root: string,
  _curDir?: string,
  _result?: Map<string, string>,
): Promise<Map<string, string>> {
  const result = _result ?? new Map<string, string>();
  const curDir = _curDir ?? root;
  const { readdir } = await import("node:fs/promises");
  let entries: import("node:fs").Dirent[];
  try {
    entries = (await readdir(curDir, { withFileTypes: true })) as import("node:fs").Dirent[];
  } catch {
    return result;
  }
  for (const entry of entries) {
    const full = path.join(curDir, entry.name as string);
    if (entry.isDirectory()) {
      await readTree(root, full, result);
    } else if (entry.isFile()) {
      const rel = path.relative(root, full).split(path.sep).join("/");
      result.set(rel, await readFile(full, "utf8"));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// §10 tests
// ---------------------------------------------------------------------------

test("seed-reconcile/fresh-workspace: reconcile is byte-identical to seedDirMissing", async () => {
  await withTmpDir(async (dir) => {
    const tmplDir = path.join(dir, "templates", "workspace");
    const wsA = path.join(dir, "wsA"); // seedDirMissing
    const wsB = path.join(dir, "wsB"); // reconcileWorkspace

    // Create a template tree.
    await mkdir(path.join(tmplDir, "skills"), { recursive: true });
    await writeFile(path.join(tmplDir, "README.md"), "# Hello\n");
    await writeFile(path.join(tmplDir, "skills", "TOOLS.md"), "tools content\n");
    await mkdir(wsA, { recursive: true });
    await mkdir(wsB, { recursive: true });

    // First-run legacy path.
    await seedDirMissing(tmplDir, wsA);

    // Reconcile path.
    const ledger = new MemLedger("test-agent");
    const sources: ReconcileSource[] = [{ source: "workspace", srcDir: tmplDir, destDir: wsB }];
    const counts = await reconcileWorkspace("test-agent", sources, ledger, { updateUnmodified: true });

    assert.equal(counts.seeded, 2, "two files seeded");
    assert.equal(counts.updated, 0);
    assert.equal(counts.driftNotices, 0);
    assert.equal(counts.tombstonesSkipped, 0);

    // File contents must be identical.
    const treeA = await readTree(wsA);
    const treeB = await readTree(wsB);
    assert.deepEqual([...treeB.entries()].sort(), [...treeA.entries()].sort(), "byte-identical");

    // Ledger populated with origin='seeded'.
    assert.equal(ledger.rows.size, 2);
    for (const [, row] of ledger.rows) {
      assert.equal(row.origin, "seeded");
    }
  });
});

test("seed-reconcile/adoption: pre-existing files adopted; absent template paths seeded (§5.1)", async () => {
  await withTmpDir(async (dir) => {
    const tmplDir = path.join(dir, "templates");
    const ws = path.join(dir, "ws");

    // Template: two files.
    await mkdir(tmplDir, { recursive: true });
    await writeFile(path.join(tmplDir, "existing.md"), "original\n");
    await writeFile(path.join(tmplDir, "missing.md"), "will be seeded\n");

    // Workspace already has existing.md (pre-boot file).
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, "existing.md"), "original\n");

    const { logger, entries } = makeCapturingLogger();
    const ledger = new MemLedger("agent");
    const sources: ReconcileSource[] = [{ source: "workspace", srcDir: tmplDir, destDir: ws }];
    const counts = await reconcileWorkspace("agent", sources, ledger, { updateUnmodified: true, logger });

    // existing.md → adopted (case 2), missing.md → seeded (case 1).
    assert.equal(counts.seeded, 1, "missing.md seeded");
    assert.equal(counts.updated, 0);

    assert.equal(ledger.rows.get("existing.md")?.origin, "adopted", "pre-existing file adopted");
    assert.equal(ledger.rows.get("missing.md")?.origin, "seeded", "missing file seeded");

    // Content of adopted file is untouched.
    assert.equal(await readFile(path.join(ws, "existing.md"), "utf8"), "original\n");

    // seeded → info log; adopted → debug log.
    const seedLog = entries.find((e) => e.level === "info" && e.message.includes("seeded"));
    assert.ok(seedLog, "seeded file logged at info");
    const adoptLog = entries.find((e) => e.level === "debug" && e.message.includes("adopted"));
    assert.ok(adoptLog, "adopted file logged at debug");
  });
});

test("seed-reconcile/tombstone: deleted local not recreated on next reconcile", async () => {
  await withTmpDir(async (dir) => {
    const tmplDir = path.join(dir, "templates");
    const ws = path.join(dir, "ws");

    await mkdir(tmplDir, { recursive: true });
    await writeFile(path.join(tmplDir, "skill.md"), "skill content\n");
    await mkdir(ws, { recursive: true });

    const ledger = new MemLedger("agent");
    const sources: ReconcileSource[] = [{ source: "workspace", srcDir: tmplDir, destDir: ws }];

    // First reconcile: seeds the file.
    const r1 = await reconcileWorkspace("agent", sources, ledger, { updateUnmodified: true });
    assert.equal(r1.seeded, 1, "seeded on first run");
    assert.ok(ledger.rows.has("skill.md"), "ledger row created");

    // Operator deletes the local file (tombstone scenario).
    await unlink(path.join(ws, "skill.md"));

    // Second reconcile: case 3 → skip (tombstone).
    const r2 = await reconcileWorkspace("agent", sources, ledger, { updateUnmodified: true });
    assert.equal(r2.tombstonesSkipped, 1, "tombstone skipped");
    assert.equal(r2.seeded, 0, "not re-seeded");

    // File must remain absent.
    const { access } = await import("node:fs/promises");
    const { constants } = await import("node:fs");
    await assert.rejects(
      () => access(path.join(ws, "skill.md"), constants.F_OK),
      "file must still be absent",
    );

    // Template hash update on tombstoned path: stays silent (no seeding), but
    // the ledger row's template_hash MUST be updated to the new template hash.
    const oldHash = ledger.rows.get("skill.md")?.template_hash;
    assert.ok(oldHash, "row has a template_hash before template update");
    await writeFile(path.join(tmplDir, "skill.md"), "updated content\n");
    const r3 = await reconcileWorkspace("agent", sources, ledger, { updateUnmodified: true });
    assert.equal(r3.tombstonesSkipped, 1, "tombstone still skipped after template update");
    assert.equal(r3.seeded, 0, "still not re-seeded");
    await assert.rejects(
      () => access(path.join(ws, "skill.md"), constants.F_OK),
      "file must still be absent after template update",
    );
    // Ledger hash must have been silently updated to the new template hash.
    const newHash = ledger.rows.get("skill.md")?.template_hash;
    assert.notEqual(newHash, oldHash, "ledger hash updated to new template hash");
    assert.ok(newHash, "new hash is non-empty");
  });
});

test("seed-reconcile/new-file-rollout: file added to template after initial reconcile gets seeded", async () => {
  await withTmpDir(async (dir) => {
    const tmplDir = path.join(dir, "templates");
    const ws = path.join(dir, "ws");

    await mkdir(tmplDir, { recursive: true });
    await writeFile(path.join(tmplDir, "original.md"), "original\n");
    await mkdir(ws, { recursive: true });

    const ledger = new MemLedger("agent");
    const sources: ReconcileSource[] = [{ source: "workspace", srcDir: tmplDir, destDir: ws }];

    // First reconcile.
    const r1 = await reconcileWorkspace("agent", sources, ledger, { updateUnmodified: true });
    assert.equal(r1.seeded, 1);

    // New file added to template between reconciles.
    await writeFile(path.join(tmplDir, "newfile.md"), "new content\n");
    const { logger, entries } = makeCapturingLogger();
    const r2 = await reconcileWorkspace("agent", sources, ledger, { updateUnmodified: true, logger });
    assert.equal(r2.seeded, 1, "new file seeded");

    assert.equal(await readFile(path.join(ws, "newfile.md"), "utf8"), "new content\n");
    const seedLog = entries.find((e) => e.level === "info" && e.message.includes("seeded"));
    assert.ok(seedLog, "new file seeded logged at info");
  });
});

test("seed-reconcile/drift-modified: modified local with changed template → notice once, not twice", async () => {
  await withTmpDir(async (dir) => {
    const tmplDir = path.join(dir, "templates");
    const ws = path.join(dir, "ws");

    await mkdir(tmplDir, { recursive: true });
    await writeFile(path.join(tmplDir, "file.md"), "v1\n");
    await mkdir(ws, { recursive: true });

    const ledger = new MemLedger("agent");
    const sources: ReconcileSource[] = [{ source: "workspace", srcDir: tmplDir, destDir: ws }];

    // Seed v1.
    await reconcileWorkspace("agent", sources, ledger, { updateUnmodified: true });

    // Operator modifies the local copy.
    await writeFile(path.join(ws, "file.md"), "local changes\n");

    // Template bumped to v2.
    await writeFile(path.join(tmplDir, "file.md"), "v2\n");

    const { logger: l1, entries: e1 } = makeCapturingLogger();
    const r1 = await reconcileWorkspace("agent", sources, ledger, { updateUnmodified: true, logger: l1 });
    assert.equal(r1.driftNotices, 1, "drift notice on first bump");
    const notice1 = e1.find((e) => e.level === "info" && e.message.includes("modified"));
    assert.ok(notice1, "drift notice logged");
    assert.equal(notice1?.fields?.["local"], "modified", "tagged as modified");

    // Local file not modified by reconcile (modified local → no overwrite).
    assert.equal(await readFile(path.join(ws, "file.md"), "utf8"), "local changes\n");

    // Second reconcile: ledger hash already updated to v2 hash → no notice again.
    const { logger: l2, entries: e2 } = makeCapturingLogger();
    const r2 = await reconcileWorkspace("agent", sources, ledger, { updateUnmodified: true, logger: l2 });
    assert.equal(r2.driftNotices, 0, "no duplicate notice");
    const notice2 = e2.find((e) => e.level === "info" && e.message.includes("modified"));
    assert.ok(!notice2, "no repeat drift log");
  });
});

test("seed-reconcile/drift-preapplied: operator-applied update logged silently", async () => {
  await withTmpDir(async (dir) => {
    const tmplDir = path.join(dir, "templates");
    const ws = path.join(dir, "ws");

    await mkdir(tmplDir, { recursive: true });
    await writeFile(path.join(tmplDir, "file.md"), "v1\n");
    await mkdir(ws, { recursive: true });

    const ledger = new MemLedger("agent");
    const sources: ReconcileSource[] = [{ source: "workspace", srcDir: tmplDir, destDir: ws }];

    // Seed v1.
    await reconcileWorkspace("agent", sources, ledger, { updateUnmodified: true });

    // Template bumped to v2; operator also updates local to v2.
    await writeFile(path.join(tmplDir, "file.md"), "v2\n");
    await writeFile(path.join(ws, "file.md"), "v2\n");

    const { logger, entries } = makeCapturingLogger();
    const r = await reconcileWorkspace("agent", sources, ledger, { updateUnmodified: true, logger });
    assert.equal(r.driftNotices, 0, "no drift notice (pre-applied)");
    assert.equal(r.updated, 0, "not counted as updated");
    const preApplied = entries.find((e) => e.message.includes("pre-applied"));
    assert.ok(preApplied, "pre-applied logged at debug");
    assert.equal(preApplied?.level, "debug");
  });
});

test("seed-reconcile/update_unmodified=on: unmodified local atomically overwritten on template change", async () => {
  await withTmpDir(async (dir) => {
    const tmplDir = path.join(dir, "templates");
    const ws = path.join(dir, "ws");

    await mkdir(tmplDir, { recursive: true });
    await writeFile(path.join(tmplDir, "file.md"), "v1\n");
    await mkdir(ws, { recursive: true });

    const ledger = new MemLedger("agent");
    const sources: ReconcileSource[] = [{ source: "workspace", srcDir: tmplDir, destDir: ws }];

    // Seed v1.
    await reconcileWorkspace("agent", sources, ledger, { updateUnmodified: true });

    // Template bumped to v2 (local still v1 — unmodified).
    await writeFile(path.join(tmplDir, "file.md"), "v2\n");

    const { logger, entries } = makeCapturingLogger();
    const r = await reconcileWorkspace("agent", sources, ledger, { updateUnmodified: true, logger });
    assert.equal(r.updated, 1, "file updated");
    assert.equal(r.driftNotices, 0, "no drift notice");

    assert.equal(await readFile(path.join(ws, "file.md"), "utf8"), "v2\n", "local updated to v2");
    const updateLog = entries.find((e) => e.level === "info" && e.message.includes("updated unmodified"));
    assert.ok(updateLog, "update logged at info");

    // Origin in ledger changed to "updated".
    assert.equal(ledger.rows.get("file.md")?.origin, "updated");
  });
});

test("seed-reconcile/update_unmodified=off: unmodified local gets notice only, not overwritten", async () => {
  await withTmpDir(async (dir) => {
    const tmplDir = path.join(dir, "templates");
    const ws = path.join(dir, "ws");

    await mkdir(tmplDir, { recursive: true });
    await writeFile(path.join(tmplDir, "file.md"), "v1\n");
    await mkdir(ws, { recursive: true });

    const ledger = new MemLedger("agent");
    const sources: ReconcileSource[] = [{ source: "workspace", srcDir: tmplDir, destDir: ws }];

    // Seed v1.
    await reconcileWorkspace("agent", sources, ledger, { updateUnmodified: false });

    // Template bumped to v2 (local still v1).
    await writeFile(path.join(tmplDir, "file.md"), "v2\n");

    const { logger, entries } = makeCapturingLogger();
    const r = await reconcileWorkspace("agent", sources, ledger, { updateUnmodified: false, logger });
    assert.equal(r.driftNotices, 1, "drift notice emitted");
    assert.equal(r.updated, 0, "file not updated");

    // Local must remain v1.
    assert.equal(await readFile(path.join(ws, "file.md"), "utf8"), "v1\n", "local unchanged");
    const notice = entries.find((e) => e.level === "info" && e.message.includes("unmodified"));
    assert.ok(notice, "notice logged");
    assert.equal(notice?.fields?.["local"], "unmodified", "tagged unmodified");
  });
});

test("seed-reconcile/crash-window: file present without ledger row is adopted (content untouched)", async () => {
  await withTmpDir(async (dir) => {
    const tmplDir = path.join(dir, "templates");
    const ws = path.join(dir, "ws");

    await mkdir(tmplDir, { recursive: true });
    await writeFile(path.join(tmplDir, "file.md"), "template content\n");
    await mkdir(ws, { recursive: true });
    // Simulate crash window: file exists but no ledger row.
    await writeFile(path.join(ws, "file.md"), "local content\n");

    const ledger = new MemLedger("agent");
    const sources: ReconcileSource[] = [{ source: "workspace", srcDir: tmplDir, destDir: ws }];

    const r = await reconcileWorkspace("agent", sources, ledger, { updateUnmodified: true });
    assert.equal(r.seeded, 0);
    assert.equal(r.updated, 0);

    const row = ledger.rows.get("file.md");
    assert.ok(row, "row created");
    assert.equal(row?.origin, "adopted", "adopted not seeded");

    // Content must be untouched.
    assert.equal(await readFile(path.join(ws, "file.md"), "utf8"), "local content\n");
  });
});

test("seed-reconcile/agents-mode: two agents have disjoint ledgers", async () => {
  await withTmpDir(async (dir) => {
    const tmplDir = path.join(dir, "templates");
    const wsA = path.join(dir, "wsA");
    const wsB = path.join(dir, "wsB");

    await mkdir(tmplDir, { recursive: true });
    await writeFile(path.join(tmplDir, "file.md"), "shared template\n");
    await mkdir(wsA, { recursive: true });
    await mkdir(wsB, { recursive: true });

    const ledgerA = new MemLedger("agentA");
    const ledgerB = new MemLedger("agentB");
    const sources = (ws: string): ReconcileSource[] => [{ source: "workspace", srcDir: tmplDir, destDir: ws }];

    // Both seed independently.
    await reconcileWorkspace("agentA", sources(wsA), ledgerA, { updateUnmodified: true });
    await reconcileWorkspace("agentB", sources(wsB), ledgerB, { updateUnmodified: true });

    assert.ok(ledgerA.rows.has("file.md"), "agentA ledger has row");
    assert.ok(ledgerB.rows.has("file.md"), "agentB ledger has row");
    assert.equal(ledgerA.rows.get("file.md")?.agent_name, "agentA");
    assert.equal(ledgerB.rows.get("file.md")?.agent_name, "agentB");

    // AgentA deletes its local file → tombstone for A.
    await unlink(path.join(wsA, "file.md"));
    const rA = await reconcileWorkspace("agentA", sources(wsA), ledgerA, { updateUnmodified: true });
    assert.equal(rA.tombstonesSkipped, 1, "agentA: tombstone");

    // AgentB's ledger and workspace are unaffected.
    const rB = await reconcileWorkspace("agentB", sources(wsB), ledgerB, { updateUnmodified: true });
    assert.equal(rB.tombstonesSkipped, 0, "agentB: no tombstone");
    assert.equal(rB.seeded, 0, "agentB: nothing re-seeded");
    assert.equal(await readFile(path.join(wsB, "file.md"), "utf8"), "shared template\n");
  });
});

test("seed-reconcile/feature-sources: disabled feature not walked; tombstone survives re-enable", async () => {
  await withTmpDir(async (dir) => {
    const featureSkillsDir = path.join(dir, "templates", "features", "browser", "skills");
    const ws = path.join(dir, "ws");
    const skillsDest = path.join(ws, "skills");

    await mkdir(featureSkillsDir, { recursive: true });
    await writeFile(path.join(featureSkillsDir, "browser.md"), "browser skill\n");
    await mkdir(skillsDest, { recursive: true });

    const ledger = new MemLedger("agent");

    const enabledSources = (): ReconcileSource[] => [
      { source: "feature:browser", srcDir: featureSkillsDir, destDir: skillsDest },
    ];
    const disabledSources = (): ReconcileSource[] => []; // feature disabled → empty

    // First reconcile with feature enabled → seeded.
    const r1 = await reconcileWorkspace("agent", enabledSources(), ledger, { updateUnmodified: true });
    assert.equal(r1.seeded, 1, "feature skill seeded");

    // Operator deletes the skill file.
    await unlink(path.join(skillsDest, "browser.md"));

    // Second reconcile with feature disabled → nothing walked, tombstone not touched.
    const r2 = await reconcileWorkspace("agent", disabledSources(), ledger, { updateUnmodified: true });
    assert.equal(r2.seeded, 0);
    assert.equal(r2.tombstonesSkipped, 0, "not even walked when disabled");
    // Row still exists from first run.
    assert.ok(ledger.rows.has("browser.md"), "ledger row still present");

    // Re-enable: tombstone is respected — file not recreated.
    const r3 = await reconcileWorkspace("agent", enabledSources(), ledger, { updateUnmodified: true });
    assert.equal(r3.tombstonesSkipped, 1, "tombstone honored on re-enable");
    assert.equal(r3.seeded, 0, "resurrection hazard: not re-seeded");

    const { access, constants } = await import("node:fs/promises").then(async (m) => ({
      access: m.access,
      constants: (await import("node:fs")).constants,
    }));
    await assert.rejects(
      () => access(path.join(skillsDest, "browser.md"), constants.F_OK),
      "file must remain absent after re-enable",
    );
  });
});

test("seed-reconcile/mode-off: empty sources seeds nothing", async () => {
  await withTmpDir(async (dir) => {
    const ws = path.join(dir, "ws");
    await mkdir(ws, { recursive: true });

    const ledger = new MemLedger("agent");
    const r = await reconcileWorkspace("agent", [], ledger, { updateUnmodified: true });

    assert.equal(r.seeded, 0);
    assert.equal(r.updated, 0);
    assert.equal(r.driftNotices, 0);
    assert.equal(r.tombstonesSkipped, 0);
    assert.equal(ledger.rows.size, 0, "no rows created");
    const tree = await readTree(ws);
    assert.equal(tree.size, 0, "workspace remains empty");
  });
});

test("seed-reconcile/collision-guard: second source claiming same physical path is skipped", async () => {
  await withTmpDir(async (dir) => {
    // Source A: templates/ws-source/ → destDir/
    //   file: skills/shared.md  → destDir/skills/shared.md
    // Source B: templates/feature-source/ → destDir/skills/
    //   file: shared.md         → destDir/skills/shared.md  (SAME physical path)
    const srcA = path.join(dir, "ws-source");
    const srcB = path.join(dir, "feature-source");
    const destDir = path.join(dir, "ws");

    await mkdir(path.join(srcA, "skills"), { recursive: true });
    await writeFile(path.join(srcA, "skills", "shared.md"), "from-workspace\n");
    await mkdir(srcB, { recursive: true });
    await writeFile(path.join(srcB, "shared.md"), "from-feature\n");
    await mkdir(destDir, { recursive: true });

    const ledger = new MemLedger("agent");
    const { logger, entries } = makeCapturingLogger();
    const sources: ReconcileSource[] = [
      { source: "workspace", srcDir: srcA, destDir: destDir },
      { source: "feature:x", srcDir: srcB, destDir: path.join(destDir, "skills") },
    ];

    const counts = await reconcileWorkspace("agent", sources, ledger, { updateUnmodified: true, logger });

    // Collision detected and skipped.
    assert.equal(counts.collisionsSkipped, 1, "one collision skipped");
    assert.equal(counts.seeded, 1, "only first source's file seeded");

    // Physical file has first source's content.
    assert.equal(
      await readFile(path.join(destDir, "skills", "shared.md"), "utf8"),
      "from-workspace\n",
      "first source content wins",
    );

    // No second ledger row for the colliding path.
    const rowsForShared = [...ledger.rows.entries()].filter(([, r]) => r.source === "feature:x");
    assert.equal(rowsForShared.length, 0, "no ledger row written for colliding second source");

    // Warn logged.
    const warnLog = entries.find((e) => e.level === "warn" && e.message.includes("collision"));
    assert.ok(warnLog, "collision warn logged");
    assert.equal(warnLog?.fields?.["owner"], "workspace", "owner source named correctly");
    assert.equal(warnLog?.fields?.["skipped"], "feature:x", "skipped source named correctly");

    // No drift notice.
    assert.equal(counts.driftNotices, 0, "no drift notice from collision");
  });
});

test("seed-reconcile/mode-first-run: seedDirMissing skips existing, reconcile adopts them", async () => {
  await withTmpDir(async (dir) => {
    const tmplDir = path.join(dir, "templates");
    const ws = path.join(dir, "ws");

    await mkdir(tmplDir, { recursive: true });
    await writeFile(path.join(tmplDir, "a.md"), "alpha\n");
    await writeFile(path.join(tmplDir, "b.md"), "beta\n");
    await mkdir(ws, { recursive: true });

    // Pre-populate b.md (simulates existing deployment file).
    await writeFile(path.join(ws, "b.md"), "beta\n");

    // First-run legacy mode: seedDirMissing.
    const created = await seedDirMissing(tmplDir, ws);
    assert.ok(created.some((p) => p.includes("a.md")), "a.md created by first-run");
    assert.ok(!created.some((p) => p.includes("b.md")), "b.md skipped (already exists)");

    // Verify both files are now present with correct content.
    assert.equal(await readFile(path.join(ws, "a.md"), "utf8"), "alpha\n");
    assert.equal(await readFile(path.join(ws, "b.md"), "utf8"), "beta\n");
  });
});

// ---------------------------------------------------------------------------
// Storage-backed test: real migration + workspace_seed_ledger table
// ---------------------------------------------------------------------------

test("seed-reconcile/storage-backed: real migration + SeedLedgerOps adapter round-trip", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    // Verify the table exists (migration v18→v19 ran).
    const hasTable = storage.read((db) => {
      const row = db
        .prepare("select name from sqlite_master where type='table' and name='workspace_seed_ledger'")
        .get() as { name: string } | undefined;
      return !!row;
    });
    assert.ok(hasTable, "workspace_seed_ledger table created by migration");

    // Wire a SeedLedgerOps adapter using Storage methods.
    const agentName = "test-agent";
    const ledger: SeedLedgerOps = {
      get(relPath: string) {
        return storage.getSeedLedgerRow(agentName, relPath) as SeedLedgerRow | undefined;
      },
      list() {
        return storage.listSeedLedgerRows(agentName) as SeedLedgerRow[];
      },
      async upsert(patch) {
        const now = Date.now();
        await storage.upsertSeedLedgerRow({
          agent_name: agentName,
          rel_path: patch.rel_path,
          source: patch.source,
          origin: patch.origin,
          template_hash: patch.template_hash,
          created_at: now,
          updated_at: now,
        });
      },
    };

    // No rows initially.
    assert.equal(ledger.list().length, 0, "empty ledger on fresh DB");
    assert.equal(ledger.get("any.md"), undefined, "get on unknown path returns undefined");

    // Upsert a row.
    await ledger.upsert({
      rel_path: "test.md",
      source: "workspace",
      origin: "seeded",
      template_hash: "abc123",
    });
    await storage.waitForIdle();

    const row = ledger.get("test.md");
    assert.ok(row, "row readable after upsert");
    assert.equal(row?.rel_path, "test.md");
    assert.equal(row?.source, "workspace");
    assert.equal(row?.origin, "seeded");
    assert.equal(row?.template_hash, "abc123");
    assert.equal(row?.agent_name, agentName);

    // Update same row (upsert idempotency).
    await ledger.upsert({
      rel_path: "test.md",
      source: "workspace",
      origin: "updated",
      template_hash: "def456",
    });
    await storage.waitForIdle();

    const updated = ledger.get("test.md");
    assert.equal(updated?.origin, "updated");
    assert.equal(updated?.template_hash, "def456");

    // List returns the row.
    const all = ledger.list();
    assert.equal(all.length, 1);

    // Reconcile against a real temp dir works end-to-end.
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-seed-storage-"));
    try {
      const tmplDir = path.join(tmpDir, "templates");
      const ws = path.join(tmpDir, "ws");
      await mkdir(tmplDir, { recursive: true });
      await writeFile(path.join(tmplDir, "hello.md"), "hello\n");
      await mkdir(ws, { recursive: true });

      // Use a separate ledger for agentB (doesn't conflict with test-agent).
      const agentB = "agentB";
      const ledgerB: SeedLedgerOps = {
        get: (r) => storage.getSeedLedgerRow(agentB, r) as SeedLedgerRow | undefined,
        list: () => storage.listSeedLedgerRows(agentB) as SeedLedgerRow[],
        async upsert(patch) {
          await storage.upsertSeedLedgerRow({
            agent_name: agentB,
            rel_path: patch.rel_path,
            source: patch.source,
            origin: patch.origin,
            template_hash: patch.template_hash,
            created_at: Date.now(),
            updated_at: Date.now(),
          });
        },
      };

      const sources: ReconcileSource[] = [{ source: "workspace", srcDir: tmplDir, destDir: ws }];
      const counts = await reconcileWorkspace(agentB, sources, ledgerB, { updateUnmodified: true });
      await storage.waitForIdle();

      assert.equal(counts.seeded, 1, "one file seeded");
      const seededRow = ledgerB.get("hello.md");
      assert.ok(seededRow, "row in storage-backed ledger");
      assert.equal(seededRow?.origin, "seeded");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});
