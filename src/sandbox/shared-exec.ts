/**
 * Shared-mode sandbox utilities for multi-agent support (spec §10).
 *
 * These are extracted from app.ts into a standalone module so they can be
 * unit-tested without the full application context (no Docker, no config load).
 */
import path from "node:path";
import type { ExecBackend } from "./exec-backend.js";

/**
 * Compute the longest common path-component ancestor of a set of absolute
 * paths (spec MULTI-AGENT-SUPPORT §10, shared-sandbox common parent).
 *
 * Returns the deepest directory whose path-component prefix is shared by every
 * input path. For a single path this is the path itself (the tightest possible
 * bind — the agent's own root). Falls back to the filesystem root when the
 * paths share no component beyond the root.
 *
 * Only used with resolved absolute paths on the local OS (path.sep, not POSIX).
 *
 * Examples:
 *   ["/workspaces/rin"]                     → "/workspaces/rin"  (single path)
 *   ["/workspaces/rin", "/workspaces/miku"] → "/workspaces"
 *   ["/a/b/c", "/a/b/d"]                   → "/a/b"
 *   ["/a/x", "/b/y"]                        → "/"  (POSIX) / "\" (Windows)
 */
export function computeCommonAncestor(absolutePaths: string[]): string {
  if (absolutePaths.length === 0) return path.sep;
  if (absolutePaths.length === 1) return absolutePaths[0]!;
  const split = absolutePaths.map((p) => p.split(path.sep));
  // All paths are absolute, so split[i][0] is "" on POSIX (before the leading /).
  const first = split[0]!;
  let commonLen = 0;
  outer: for (let i = 0; i < first.length; i++) {
    for (const parts of split) {
      if (parts[i] !== first[i]) break outer;
    }
    commonLen = i + 1;
  }
  const joined = first.slice(0, commonLen).join(path.sep);
  // On POSIX an all-components match produces e.g. "/workspaces"; a zero-match
  // produces "" (empty string before the leading "/"). Normalise both to a valid
  // absolute path.
  return joined || path.sep;
}

/**
 * Wrap an ExecBackend so every exec's working directory is prefixed with the
 * given agent subdir (spec MULTI-AGENT-SUPPORT §10 shared-mode cwd routing).
 *
 * In shared mode the sandbox container is mounted at the COMMON PARENT of all
 * shared agents' workspace roots. Each agent's subdir within that parent must
 * be prepended to the per-call cwd so the exec lands in the right workspace.
 *
 * @param base       The underlying (shared) sandbox ExecBackend.
 * @param agentSubdir  POSIX-relative path from the mount root to this agent's
 *   workspace root (e.g. "rin" when the agent root is under "workspaces/rin"
 *   and the common ancestor is "workspaces/"). May be nested (e.g. "team/rin").
 */
export function createSharedExecBackend(base: ExecBackend, agentSubdir: string): ExecBackend {
  return {
    exec(command, options) {
      const userCwd = options?.cwd;
      let adjustedCwd: string;
      if (!userCwd || userCwd === "." || userCwd === "./") {
        // No caller-supplied cwd: default to the agent's subdir.
        adjustedCwd = agentSubdir;
      } else {
        // Combine agent subdir with the caller's relative cwd using POSIX join
        // (the container is always Linux; mapContainerCwd normalizes further).
        adjustedCwd = path.posix.join(agentSubdir, userCwd);
      }
      return base.exec(command, { ...options, cwd: adjustedCwd });
    },
  };
}
