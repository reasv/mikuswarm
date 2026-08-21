/**
 * Channel Visibility Resolver (ARCHITECTURE.md §9h).
 *
 * The single authority for the `[visibility]` config block — no subsystem
 * reads `config.visibility` directly; everything goes through this resolver
 * so the precedence rules live in exactly one place.
 *
 * Mode hierarchy (most-specific wins):
 *   exact `timeline_key` entry → `dms` blanket (dm-kind only) → "shared"
 *
 * Thread inheritance: `:thread:<id>` suffixes are stripped before lookup,
 * so a thread always resolves to its parent room's mode.
 */

import { parseTimelineKey, buildTimelineKey } from "../storage/timeline-key.js";
import type { Logger } from "../observability/index.js";

export type VisibilityMode = "shared" | "no_diary" | "isolated";

/**
 * One entry in `[[visibility.channels]]`.
 */
export interface VisibilityChannelEntry {
  timeline_key: string;
  mode: VisibilityMode;
}

/**
 * The resolved `[visibility]` config block passed to the resolver constructor.
 * Matches the TypeBox schema shape produced by the config loader.
 */
export interface VisibilityConfig {
  dms?: VisibilityMode;
  channels?: VisibilityChannelEntry[];
}

/**
 * Strip any `:thread:<id>` suffix from a timeline key, returning the parent
 * room key. Threads inherit their parent's mode (§4 "Thread inheritance").
 * Returns the key unchanged when there is no thread suffix.
 */
function stripThread(key: string): string {
  const parsed = parseTimelineKey(key);
  if (!parsed || !parsed.threadId) return key;
  // Rebuild without the thread part (buildTimelineKey omits threadId when absent)
  return buildTimelineKey({
    provider: parsed.provider,
    accountId: parsed.accountId,
    kind: parsed.kind,
    channelId: parsed.channelId,
  });
}

/**
 * Pre-built resolver — constructed once at config load, injected wherever
 * mode lookups are needed. Immutable after construction.
 */
export class ChannelVisibilityResolver {
  /** Exact timeline_key → mode map (thread suffixes already stripped at build time). */
  private readonly exact: Map<string, VisibilityMode>;
  /** Blanket mode for all dm-kind timelines. */
  private readonly dmsBlanket: VisibilityMode;
  /** Whether any "isolated" mode is configured anywhere. */
  private readonly _hasIsolation: boolean;

  constructor(cfg: VisibilityConfig | undefined, logger?: Logger) {
    this.dmsBlanket = cfg?.dms ?? "shared";

    this.exact = new Map<string, VisibilityMode>();
    for (const entry of cfg?.channels ?? []) {
      this.exact.set(entry.timeline_key, entry.mode);
    }

    this._hasIsolation =
      this.dmsBlanket === "isolated" ||
      [...this.exact.values()].some((m) => m === "isolated");

    void logger; // logger available for future debug tracing if needed
  }

  /**
   * Resolve the visibility mode for a timeline key.
   *
   * - Malformed keys resolve to "shared" with a `timeline_key.malformed` log
   *   (per the established convention — policy must never crash a worker or a
   *   tool call).
   * - Thread keys inherit their parent room's mode.
   * - Precedence: exact entry → dms blanket (dm-kind only) → "shared".
   */
  modeFor(timelineKey: string, logger?: Logger): VisibilityMode {
    const parsed = parseTimelineKey(timelineKey);
    if (!parsed) {
      logger?.warn("timeline_key.malformed", {
        timelineKey,
        context: "visibility.modeFor",
      });
      return "shared";
    }

    // Strip thread suffix — threads always inherit the parent room's mode.
    const canonicalKey = parsed.threadId
      ? buildTimelineKey({
          provider: parsed.provider,
          accountId: parsed.accountId,
          kind: parsed.kind,
          channelId: parsed.channelId,
        })
      : timelineKey;

    // 1. Exact entry match (most specific).
    const exactMode = this.exact.get(canonicalKey);
    if (exactMode !== undefined) return exactMode;

    // 2. DM blanket (applies to dm-kind timelines only).
    if (parsed.kind === "dm") return this.dmsBlanket;

    // 3. Default: shared.
    return "shared";
  }

  /**
   * Thread-stripped key equality — the viewer check for isolated channels (§6.2).
   * Two keys "are the same channel" when their canonical (thread-stripped) forms
   * are equal.
   */
  sameChannel(a: string, b: string): boolean {
    return stripThread(a) === stripThread(b);
  }

  /**
   * True when any "isolated" mode is configured anywhere. When false, every
   * search path keeps its exact current shape (including the `undefined`
   * no-filter fast path from `resolveRoomsForAgent` in legacy mode), so the
   * feature is a pure no-op for deployments that never touch `[visibility]`.
   */
  hasIsolation(): boolean {
    return this._hasIsolation;
  }
}

/**
 * Singleton "all-shared" resolver — safe to use as a default when no
 * `[visibility]` block is configured. Zero overhead: all lookups return
 * "shared" and `hasIsolation()` returns false.
 */
export const DEFAULT_RESOLVER = new ChannelVisibilityResolver(undefined);

/**
 * Fail-fast validation of the `[visibility]` config block (ARCHITECTURE.md §9h).
 * Called at startup before constructing the resolver so config errors abort the
 * process with a human-readable message rather than silently misbehaving.
 *
 * Checks:
 * - Every `timeline_key` in `[[visibility.channels]]` must parse as a valid key.
 * - Parsed kind must be "room" or "dm" (no "thread" entries — threads inherit
 *   their parent room's mode automatically; v1 does not support per-thread config).
 * - No `:thread:` suffix (the parsed `threadId` field would be set).
 * - No duplicate `timeline_key` values.
 *
 * Throws an `Error` with a descriptive message on the first violation found.
 * Enum validation (`mode`, `dms`) is handled by the TypeBox schema at config
 * parse time and is not re-checked here.
 */
export function validateVisibilityChannels(cfg: VisibilityConfig | undefined): void {
  if (!cfg?.channels) return;
  const seen = new Set<string>();
  for (const entry of cfg.channels) {
    const parsed = parseTimelineKey(entry.timeline_key);
    if (!parsed) {
      throw new Error(
        `visibility.channels: "${entry.timeline_key}" is not a valid timeline_key — must match <provider>:<accountId>:<kind>:<channelId>`,
      );
    }
    if (parsed.kind !== "room" && parsed.kind !== "dm") {
      throw new Error(
        `visibility.channels: "${entry.timeline_key}" has unsupported kind "${parsed.kind}" — only "room" and "dm" are valid`,
      );
    }
    if (parsed.threadId !== undefined) {
      throw new Error(
        `visibility.channels: "${entry.timeline_key}" has a :thread: suffix — per-thread granularity is not supported in v1 (threads inherit their parent room's mode)`,
      );
    }
    if (seen.has(entry.timeline_key)) {
      throw new Error(
        `visibility.channels: duplicate entry for timeline_key "${entry.timeline_key}"`,
      );
    }
    seen.add(entry.timeline_key);
  }
}
