import { recentMemoryWindow } from "../diary/recent-window.js";

/**
 * The recent-diary surfacing content (ARCHITECTURE.md §10a) — the read side of the
 * diary, without which it is write-only. Loads the recent-memory window (§9a)
 * anchored at the latest in-context message day and wraps it for the agent so it
 * reads back what it previously wrote. Cross-room is intentional: a flat recency
 * dump across the global memory store, exactly what worked in OpenClaw; each block
 * carries its own `· <ROOM>` header for attribution.
 *
 * Returns null when there is nothing to surface (no day files / empty window).
 */
export async function buildRecentDiaryContent(opts: {
  workspaceRoot: string;
  anchorDay: string;
  ceilingTokens: number;
  fileCount: number;
}): Promise<string | null> {
  const window = await recentMemoryWindow(opts);
  if (window.trim().length === 0) return null;
  return (
    `<recent_memory note="Your own recent diary entries across all channels (most recent last). Read-only context for continuity — refer back to it, don't repeat it.">\n` +
    `${window}\n` +
    `</recent_memory>`
  );
}
