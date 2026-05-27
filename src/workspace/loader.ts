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
  const fileNames = sessionType?.workspace_files ?? DEFAULT_WORKSPACE_FILES;
  const files = new Map<string, string>();

  await Promise.all(
    fileNames.map(async (filename) => {
      const resolved = resolveWorkspacePath(workspaceRoot, filename);
      if (resolved === null) return;
      const content = await readFileSafe(resolved);
      if (content !== null) {
        files.set(filename, content);
      }
    }),
  );

  // Load tail file
  let tailContent: string | null = null;
  if (sessionType?.tail_file === null) {
    // Explicitly suppressed
    tailContent = null;
  } else {
    const tailFilename = sessionType?.tail_file ?? DEFAULT_TAIL_FILE;
    const resolvedTail = resolveWorkspacePath(workspaceRoot, tailFilename);
    tailContent = resolvedTail !== null ? await readFileSafe(resolvedTail) : null;
  }

  // Scan skills
  const skillFilter = sessionType?.skills ?? "all";
  const skills = await scanSkills(workspaceRoot, skillFilter);

  return { files, tailContent, skills };
}

/**
 * Resolve a filename relative to the workspace root, returning null if the
 * resolved path escapes the workspace root (path traversal protection).
 */
function resolveWorkspacePath(workspaceRoot: string, filename: string): string | null {
  const resolved = path.resolve(workspaceRoot, filename);
  if (!resolved.startsWith(path.resolve(workspaceRoot) + path.sep) && resolved !== path.resolve(workspaceRoot)) {
    console.warn(`[workspace] Path traversal blocked: ${filename} resolves outside workspace root`);
    return null;
  }
  return resolved;
}

/**
 * Read a file, returning null if it does not exist.
 * Logs a warning for unexpected errors (permissions, I/O, etc.) and returns null.
 */
async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return null;
    }
    console.warn(`[workspace] Failed to read file: ${filePath}`, isNodeError(err) ? err.code : err);
    return null;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
