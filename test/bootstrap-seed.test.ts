import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  seedConfigDir,
  seedDirMissing,
  seedFeatureSkills,
  seedWorkspace,
  resolveTemplatesDir,
} from "../src/bootstrap/seed.js";

async function tmp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "miku-seed-"));
}

async function exists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

async function writeFileMk(p: string, content: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, content);
}

/** Build a small template tree under `root` for seedDirMissing tests. */
async function buildSrcTree(root: string): Promise<void> {
  await writeFileMk(path.join(root, "AGENTS.md"), "agents-src");
  await writeFileMk(path.join(root, "TOOLS.md"), "tools-src");
  await writeFileMk(path.join(root, "skills", "alpha", "SKILL.md"), "alpha-src");
  await writeFileMk(path.join(root, "skills", "beta", "SKILL.md"), "beta-src");
}

test("seedDirMissing: empty dest copies every template file", async () => {
  const src = await tmp();
  const dest = await tmp();
  try {
    await buildSrcTree(src);
    const created = await seedDirMissing(src, dest);
    assert.equal(created.length, 4);
    assert.equal(await readFile(path.join(dest, "AGENTS.md"), "utf8"), "agents-src");
    assert.equal(await readFile(path.join(dest, "TOOLS.md"), "utf8"), "tools-src");
    assert.equal(await readFile(path.join(dest, "skills", "alpha", "SKILL.md"), "utf8"), "alpha-src");
    assert.equal(await readFile(path.join(dest, "skills", "beta", "SKILL.md"), "utf8"), "beta-src");
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test("seedDirMissing: fully-populated dest => ZERO writes, contents byte-identical (live case)", async () => {
  const src = await tmp();
  const dest = await tmp();
  try {
    await buildSrcTree(src);
    // Pre-populate dest with DIFFERENT contents at every path the template has.
    await writeFileMk(path.join(dest, "AGENTS.md"), "AGENTS-LIVE");
    await writeFileMk(path.join(dest, "TOOLS.md"), "TOOLS-LIVE");
    await writeFileMk(path.join(dest, "skills", "alpha", "SKILL.md"), "ALPHA-LIVE");
    await writeFileMk(path.join(dest, "skills", "beta", "SKILL.md"), "BETA-LIVE");

    const created = await seedDirMissing(src, dest);
    assert.deepEqual(created, [], "no files should be created");
    // Existing contents must be untouched (never overwritten).
    assert.equal(await readFile(path.join(dest, "AGENTS.md"), "utf8"), "AGENTS-LIVE");
    assert.equal(await readFile(path.join(dest, "TOOLS.md"), "utf8"), "TOOLS-LIVE");
    assert.equal(await readFile(path.join(dest, "skills", "alpha", "SKILL.md"), "utf8"), "ALPHA-LIVE");
    assert.equal(await readFile(path.join(dest, "skills", "beta", "SKILL.md"), "utf8"), "BETA-LIVE");
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test("seedDirMissing: partially-populated dest => only missing files added, existing untouched", async () => {
  const src = await tmp();
  const dest = await tmp();
  try {
    await buildSrcTree(src);
    // Only AGENTS.md and skills/alpha exist already.
    await writeFileMk(path.join(dest, "AGENTS.md"), "AGENTS-LIVE");
    await writeFileMk(path.join(dest, "skills", "alpha", "SKILL.md"), "ALPHA-LIVE");

    const created = await seedDirMissing(src, dest);
    // Only the two genuinely-missing files copied.
    assert.equal(created.length, 2);
    const createdSet = new Set(created.map((p) => path.relative(dest, p)));
    assert.ok(createdSet.has("TOOLS.md"));
    assert.ok(createdSet.has(path.join("skills", "beta", "SKILL.md")));
    // Pre-existing files untouched.
    assert.equal(await readFile(path.join(dest, "AGENTS.md"), "utf8"), "AGENTS-LIVE");
    assert.equal(await readFile(path.join(dest, "skills", "alpha", "SKILL.md"), "utf8"), "ALPHA-LIVE");
    // Missing ones now match the template.
    assert.equal(await readFile(path.join(dest, "TOOLS.md"), "utf8"), "tools-src");
    assert.equal(await readFile(path.join(dest, "skills", "beta", "SKILL.md"), "utf8"), "beta-src");
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test("seedDirMissing: missing source => no-op, no throw", async () => {
  const dest = await tmp();
  try {
    const created = await seedDirMissing(path.join(dest, "does-not-exist"), dest);
    assert.deepEqual(created, []);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test("seedConfigDir: empty config dir seeds 90-local + 00-defaults from templates root", async () => {
  const templatesRoot = await tmp();
  const repoRoot = await tmp();
  const configDir = await tmp();
  const prevTemplates = process.env.MIKUSWARM_TEMPLATES_DIR;
  const prevCwd = process.cwd();
  try {
    await writeFileMk(path.join(templatesRoot, "config", "90-local.toml"), "local-template");
    await writeFileMk(path.join(repoRoot, "config", "00-defaults.toml"), "defaults-template");
    process.env.MIKUSWARM_TEMPLATES_DIR = templatesRoot;
    process.chdir(repoRoot); // seedConfigDir reads <cwd>/config/00-defaults.toml

    await seedConfigDir(configDir);
    assert.equal(await readFile(path.join(configDir, "90-local.toml"), "utf8"), "local-template");
    assert.equal(await readFile(path.join(configDir, "00-defaults.toml"), "utf8"), "defaults-template");
  } finally {
    process.chdir(prevCwd);
    if (prevTemplates === undefined) delete process.env.MIKUSWARM_TEMPLATES_DIR;
    else process.env.MIKUSWARM_TEMPLATES_DIR = prevTemplates;
    await rm(templatesRoot, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test("seedConfigDir: populated config dir is a strict no-op (no overwrite)", async () => {
  const templatesRoot = await tmp();
  const repoRoot = await tmp();
  const configDir = await tmp();
  const prevTemplates = process.env.MIKUSWARM_TEMPLATES_DIR;
  const prevCwd = process.cwd();
  try {
    await writeFileMk(path.join(templatesRoot, "config", "90-local.toml"), "local-template");
    await writeFileMk(path.join(repoRoot, "config", "00-defaults.toml"), "defaults-template");
    // Pre-existing, DIFFERENT config (the live case).
    await writeFileMk(path.join(configDir, "90-local.toml"), "LIVE-LOCAL");
    await writeFileMk(path.join(configDir, "00-defaults.toml"), "LIVE-DEFAULTS");
    process.env.MIKUSWARM_TEMPLATES_DIR = templatesRoot;
    process.chdir(repoRoot);

    await seedConfigDir(configDir);
    assert.equal(await readFile(path.join(configDir, "90-local.toml"), "utf8"), "LIVE-LOCAL");
    assert.equal(await readFile(path.join(configDir, "00-defaults.toml"), "utf8"), "LIVE-DEFAULTS");
  } finally {
    process.chdir(prevCwd);
    if (prevTemplates === undefined) delete process.env.MIKUSWARM_TEMPLATES_DIR;
    else process.env.MIKUSWARM_TEMPLATES_DIR = prevTemplates;
    await rm(templatesRoot, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test("seedConfigDir: never throws when templates missing", async () => {
  const configDir = await tmp();
  const prevTemplates = process.env.MIKUSWARM_TEMPLATES_DIR;
  try {
    process.env.MIKUSWARM_TEMPLATES_DIR = path.join(configDir, "no-templates-here");
    await seedConfigDir(configDir); // must not throw
    assert.ok(true);
  } finally {
    if (prevTemplates === undefined) delete process.env.MIKUSWARM_TEMPLATES_DIR;
    else process.env.MIKUSWARM_TEMPLATES_DIR = prevTemplates;
    await rm(configDir, { recursive: true, force: true });
  }
});

test("seedWorkspace: seeds when empty (no AGENTS.md/SOUL.md)", async () => {
  const templatesRoot = await tmp();
  const workspace = await tmp();
  const prevTemplates = process.env.MIKUSWARM_TEMPLATES_DIR;
  try {
    await writeFileMk(path.join(templatesRoot, "workspace", "AGENTS.md"), "agents-tpl");
    await writeFileMk(path.join(templatesRoot, "workspace", "SOUL.md"), "soul-tpl");
    await writeFileMk(path.join(templatesRoot, "workspace", "skills", "x", "SKILL.md"), "x-tpl");
    process.env.MIKUSWARM_TEMPLATES_DIR = templatesRoot;

    await seedWorkspace(workspace);
    assert.equal(await readFile(path.join(workspace, "AGENTS.md"), "utf8"), "agents-tpl");
    assert.equal(await readFile(path.join(workspace, "SOUL.md"), "utf8"), "soul-tpl");
    assert.equal(await readFile(path.join(workspace, "skills", "x", "SKILL.md"), "utf8"), "x-tpl");
  } finally {
    if (prevTemplates === undefined) delete process.env.MIKUSWARM_TEMPLATES_DIR;
    else process.env.MIKUSWARM_TEMPLATES_DIR = prevTemplates;
    await rm(templatesRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("seedWorkspace: emptiness gate skips when AGENTS.md present (live persona safe)", async () => {
  const templatesRoot = await tmp();
  const workspace = await tmp();
  const prevTemplates = process.env.MIKUSWARM_TEMPLATES_DIR;
  try {
    await writeFileMk(path.join(templatesRoot, "workspace", "AGENTS.md"), "agents-tpl");
    await writeFileMk(path.join(templatesRoot, "workspace", "TOOLS.md"), "tools-tpl");
    process.env.MIKUSWARM_TEMPLATES_DIR = templatesRoot;
    // Established workspace: AGENTS.md present, but TOOLS.md absent.
    await writeFileMk(path.join(workspace, "AGENTS.md"), "AGENTS-LIVE");

    await seedWorkspace(workspace);
    // Gate tripped => no seeding at all; TOOLS.md must NOT have been added.
    assert.equal(await readFile(path.join(workspace, "AGENTS.md"), "utf8"), "AGENTS-LIVE");
    assert.equal(await exists(path.join(workspace, "TOOLS.md")), false);
  } finally {
    if (prevTemplates === undefined) delete process.env.MIKUSWARM_TEMPLATES_DIR;
    else process.env.MIKUSWARM_TEMPLATES_DIR = prevTemplates;
    await rm(templatesRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("seedWorkspace: emptiness gate also trips on SOUL.md alone", async () => {
  const templatesRoot = await tmp();
  const workspace = await tmp();
  const prevTemplates = process.env.MIKUSWARM_TEMPLATES_DIR;
  try {
    await writeFileMk(path.join(templatesRoot, "workspace", "AGENTS.md"), "agents-tpl");
    process.env.MIKUSWARM_TEMPLATES_DIR = templatesRoot;
    await writeFileMk(path.join(workspace, "SOUL.md"), "SOUL-LIVE"); // persona present

    await seedWorkspace(workspace);
    assert.equal(await exists(path.join(workspace, "AGENTS.md")), false);
    assert.equal(await readFile(path.join(workspace, "SOUL.md"), "utf8"), "SOUL-LIVE");
  } finally {
    if (prevTemplates === undefined) delete process.env.MIKUSWARM_TEMPLATES_DIR;
    else process.env.MIKUSWARM_TEMPLATES_DIR = prevTemplates;
    await rm(templatesRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("seedFeatureSkills: seeds only enabled features into workspace/skills", async () => {
  const templatesRoot = await tmp();
  const workspace = await tmp();
  const prevTemplates = process.env.MIKUSWARM_TEMPLATES_DIR;
  try {
    await writeFileMk(
      path.join(templatesRoot, "features", "character_card", "skills", "character-card", "SKILL.md"),
      "cc-tpl",
    );
    await writeFileMk(
      path.join(templatesRoot, "features", "danbooru", "skills", "danbooru", "SKILL.md"),
      "db-tpl",
    );
    process.env.MIKUSWARM_TEMPLATES_DIR = templatesRoot;

    // Only character_card enabled.
    await seedFeatureSkills(workspace, ["character_card"]);
    assert.equal(
      await readFile(path.join(workspace, "skills", "character-card", "SKILL.md"), "utf8"),
      "cc-tpl",
    );
    // danbooru not enabled => its skill must be absent.
    assert.equal(await exists(path.join(workspace, "skills", "danbooru", "SKILL.md")), false);
  } finally {
    if (prevTemplates === undefined) delete process.env.MIKUSWARM_TEMPLATES_DIR;
    else process.env.MIKUSWARM_TEMPLATES_DIR = prevTemplates;
    await rm(templatesRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("seedFeatureSkills: no-op when the skill dir already exists (no overwrite)", async () => {
  const templatesRoot = await tmp();
  const workspace = await tmp();
  const prevTemplates = process.env.MIKUSWARM_TEMPLATES_DIR;
  try {
    await writeFileMk(
      path.join(templatesRoot, "features", "character_card", "skills", "character-card", "SKILL.md"),
      "cc-tpl",
    );
    process.env.MIKUSWARM_TEMPLATES_DIR = templatesRoot;
    // Pre-existing, edited skill (the live case).
    await writeFileMk(path.join(workspace, "skills", "character-card", "SKILL.md"), "CC-LIVE");

    await seedFeatureSkills(workspace, ["character_card"]);
    assert.equal(
      await readFile(path.join(workspace, "skills", "character-card", "SKILL.md"), "utf8"),
      "CC-LIVE",
    );
  } finally {
    if (prevTemplates === undefined) delete process.env.MIKUSWARM_TEMPLATES_DIR;
    else process.env.MIKUSWARM_TEMPLATES_DIR = prevTemplates;
    await rm(templatesRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("resolveTemplatesDir: env override wins, else <cwd>/templates", async () => {
  const prev = process.env.MIKUSWARM_TEMPLATES_DIR;
  try {
    process.env.MIKUSWARM_TEMPLATES_DIR = "/some/custom/templates";
    assert.equal(resolveTemplatesDir(), path.resolve("/some/custom/templates"));
    delete process.env.MIKUSWARM_TEMPLATES_DIR;
    assert.equal(resolveTemplatesDir(), path.resolve(process.cwd(), "templates"));
  } finally {
    if (prev === undefined) delete process.env.MIKUSWARM_TEMPLATES_DIR;
    else process.env.MIKUSWARM_TEMPLATES_DIR = prev;
  }
});
