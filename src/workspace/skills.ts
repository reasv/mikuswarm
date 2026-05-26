import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SkillIndex, SkillMeta } from "./types.js";

/**
 * Scan the skills directory and return skill metadata.
 *
 * Skills live in `<workspaceRoot>/skills/<skill-name>/SKILL.md`.
 * Each SKILL.md has YAML frontmatter with `name`, `description`, and
 * optionally `always_loaded`.
 *
 * @param workspaceRoot Absolute path to the workspace root directory.
 * @param filter Optional filter: "all" (default), "none", or a list of skill names.
 * @returns Scanned skill index with listed and inlined skills.
 */
export async function scanSkills(
  workspaceRoot: string,
  filter: "all" | "none" | string[] = "all",
): Promise<SkillIndex> {
  if (filter === "none") {
    return { listed: [], inlined: [] };
  }

  const skillsDir = path.join(workspaceRoot, "skills");
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return { listed: [], inlined: [] };
  }

  const listed: SkillMeta[] = [];
  const inlined: SkillMeta[] = [];

  for (const entry of entries.sort()) {
    const skillFilePath = path.join(skillsDir, entry, "SKILL.md");
    let raw: string;
    try {
      raw = await readFile(skillFilePath, "utf-8");
    } catch {
      continue;
    }

    const parsed = parseFrontmatter(raw);
    if (!parsed) continue;

    const { frontmatter, body } = parsed;
    const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
    const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
    if (!name || !description) continue;

    // Apply filter
    if (Array.isArray(filter) && !filter.includes(name)) continue;

    const alwaysLoaded = frontmatter.always_loaded === true;
    const relativePath = path.posix.join("skills", entry, "SKILL.md");

    const meta: SkillMeta = {
      name,
      description,
      path: relativePath,
      alwaysLoaded,
    };

    if (alwaysLoaded) {
      meta.content = body;
      inlined.push(meta);
    } else {
      listed.push(meta);
    }
  }

  return { listed, inlined };
}

interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Handles the simple case: `---` delimited block at the start of the file
 * with `key: value` lines. Supports string values (optionally quoted),
 * boolean `true`/`false`, and ignores everything else.
 */
function parseFrontmatter(raw: string): ParsedFrontmatter | null {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) return null;

  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) return null;

  const fmBlock = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 4).replace(/^[\r\n]+/, "");

  const frontmatter: Record<string, unknown> = {};
  for (const line of fmBlock.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    let value: string | boolean = line.slice(colonIndex + 1).trim();

    if (!key) continue;

    // Strip quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else if (value === "true") {
      value = true;
    } else if (value === "false") {
      value = false;
    }

    frontmatter[key] = value;
  }

  return { frontmatter, body };
}
