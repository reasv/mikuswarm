import path from "node:path";

export function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, requestedPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }
  return resolved;
}

export function workspaceRelative(workspaceRoot: string, absolutePath: string): string {
  return path.relative(path.resolve(workspaceRoot), path.resolve(absolutePath)) || ".";
}
