import path from "node:path";
import { existsSync, realpathSync } from "node:fs";

export function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, requestedPath);
  assertInside(root, resolved, requestedPath);

  const rootReal = realpathSync.native(root);
  const existing = nearestExistingPath(resolved);
  const existingReal = realpathSync.native(existing);
  const realCandidate = path.resolve(existingReal, path.relative(existing, resolved));
  assertInside(rootReal, realCandidate, requestedPath);
  return resolved;
}

export function workspaceRelative(workspaceRoot: string, absolutePath: string): string {
  return path.relative(path.resolve(workspaceRoot), path.resolve(absolutePath)) || ".";
}

function assertInside(root: string, candidate: string, requestedPath: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }
}

function nearestExistingPath(candidate: string): string {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}
