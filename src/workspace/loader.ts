import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceContent, SessionTypeConfig } from "./types.js";
import { scanSkills } from "./skills.js";

/**
 * Default workspace files loaded into the system prompt.
 * TAIL.md is handled separately (it goes in the satellite block, not the system prompt).
 */
const DEFAULT_WORKSPACE_FILES = ["AGENTS.md", "SOUL.md", "TOOLS.md"];

/** Default tail instructions filename. */
const DEFAULT_TAIL_FILE = "TAIL.md";

/**
 * Load workspace content from disk.
 *
 * Reads workspace files, tail instructions, and scans skills.
 * Files that don't exist are silently skipped. Read errors other than
 * ENOENT are logged and the file is skipped.
 *
 * @param workspaceRoot Absolute path to the workspace root directory.
 * @param sessionType Optional session type config for file/skill filtering.
 * @returns Loaded workspace content.
 */
export async function loadWorkspace(
  workspaceRoot: string,
  sessionType?: SessionTypeConfig,
): Promise<WorkspaceContent> {
  const fileNames = sessionType?.workspaceFiles ?? DEFAULT_WORKSPACE_FILES;
  const files = new Map<string, string>();

  await Promise.all(
    fileNames.map(async (filename) => {
      const content = await readFileSafe(path.join(workspaceRoot, filename));
      if (content !== null) {
        files.set(filename, content);
      }
    }),
  );

  // Load tail file
  let tailContent: string | null = null;
  if (sessionType?.tailFile === null) {
    // Explicitly suppressed
    tailContent = null;
  } else {
    const tailFilename = sessionType?.tailFile ?? DEFAULT_TAIL_FILE;
    tailContent = await readFileSafe(path.join(workspaceRoot, tailFilename));
  }

  // Scan skills
  const skillFilter = sessionType?.skills ?? "all";
  const skills = await scanSkills(workspaceRoot, skillFilter);

  return { files, tailContent, skills };
}

/**
 * Read a file, returning null on ENOENT or other errors.
 */
async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}
