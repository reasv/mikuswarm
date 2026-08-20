import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isNodeError, type SkillIndex, type SkillMeta } from "./types.js";

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
  let dirEntries: import("node:fs").Dirent[];
  try {
    dirEntries = await readdir(skillsDir, { withFileTypes: true });
  } catch (err: unknown) {
    if (!(isNodeError(err) && err.code === "ENOENT")) {
      console.warn(`[workspace] Failed to read skills directory: ${skillsDir}`, isNodeError(err) ? err.code : err);
    }
    return { listed: [], inlined: [] };
  }

  // Filter to directories only and sort by name for deterministic ordering
  const dirs = dirEntries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));

  // Read all SKILL.md files in parallel, preserving sort order
  const readResults = await Promise.all(
    dirs.map(async (entry) => {
      const skillFilePath = path.join(skillsDir, entry.name, "SKILL.md");
      try {
        return { dirName: entry.name, raw: await readFile(skillFilePath, "utf-8") };
      } catch (err: unknown) {
        if (!(isNodeError(err) && err.code === "ENOENT")) {
          console.warn(`[workspace] Failed to read skill file: ${skillFilePath}`, isNodeError(err) ? err.code : err);
        }
        return { dirName: entry.name, raw: null };
      }
    }),
  );

  const listed: SkillMeta[] = [];
  const inlined: SkillMeta[] = [];

  for (const { dirName, raw } of readResults) {
    if (raw === null) continue;

    const parsed = parseFrontmatter(raw);
    if (!parsed) continue;

    const { frontmatter, body } = parsed;
    const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
    const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
    if (!name || !description) continue;

    // Apply filter
    if (Array.isArray(filter) && !filter.includes(name)) continue;

    const alwaysLoaded = frontmatter.always_loaded === true;
    const relativePath = path.posix.join("skills", dirName, "SKILL.md");

    const meta: SkillMeta = {
      name,
      description,
      path: relativePath,
      alwaysLoaded,
    };

    const tools = frontmatterToolPatterns(frontmatter);
    if (tools) meta.tools = tools;

    if (alwaysLoaded) {
      meta.content = body;
      inlined.push(meta);
    } else {
      listed.push(meta);
    }
  }

  return { listed, inlined };
}


export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Extract the skill's `tools` frontmatter as a pattern list (spec
 * DYNAMIC-TOOL-LOADING §4): exact tool names or trailing-`*` globs. Accepts a
 * parsed block-sequence / inline-flow list (string[]) or a single scalar string
 * (one pattern). Returns undefined when absent or empty after trimming.
 */
export function frontmatterToolPatterns(
  frontmatter: Record<string, unknown>,
): string[] | undefined {
  const raw = frontmatter["tools"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw !== "" ? [raw] : [];
  const patterns = list
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return patterns.length > 0 ? patterns : undefined;
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Handles the simple cases: `---` delimited block at the start of the file with
 * `key: value` lines. Supports string values (optionally quoted), boolean
 * `true`/`false`, inline flow lists (`key: [a, b]`), block sequences (`key:`
 * followed by `- item` lines), and ignores everything else.
 *
 * Exported for the text-editor skill-activation hook (spec DYNAMIC-TOOL-LOADING
 * §5), which parses viewed markdown files with the SAME parser the skills scan
 * uses so the two can never disagree on what counts as a skill file.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter | null {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) return null;

  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) return null;

  const fmBlock = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 4).replace(/^[\r\n]+/, "");

  const frontmatter: Record<string, unknown> = {};
  const lines = fmBlock.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Block-sequence items are consumed by their owning key below; a stray item
    // line without a preceding `key:` line is ignored.
    if (/^\s*-\s/.test(line)) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();

    if (!key) continue;

    // Block sequence: `key:` with nothing after the colon, followed by `- item`
    // lines. Collect until the first non-item line. A bare `key:` with no items
    // stores "" — the original scalar parser's behavior for an empty value.
    if (rawValue === "") {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const itemMatch = /^\s*-\s+(.*)$/.exec(lines[j]);
        if (!itemMatch) break;
        items.push(unquote(itemMatch[1].trim()));
        j++;
      }
      if (items.length > 0) {
        frontmatter[key] = items;
        i = j - 1;
      } else {
        frontmatter[key] = "";
      }
      continue;
    }

    // Inline flow list: `key: [a, b]`.
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const items = rawValue
        .slice(1, -1)
        .split(",")
        .map((item) => unquote(item.trim()))
        .filter((item) => item.length > 0);
      frontmatter[key] = items;
      continue;
    }

    // Quote-stripping and boolean coercion are mutually exclusive, matching the
    // original parser: a quoted "true" stays the string `true`.
    let value: string | boolean;
    const unquoted = unquote(rawValue);
    if (unquoted !== rawValue) value = unquoted;
    else if (rawValue === "true") value = true;
    else if (rawValue === "false") value = false;
    else value = rawValue;

    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

/** Strip one layer of matching single or double quotes. */
function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
