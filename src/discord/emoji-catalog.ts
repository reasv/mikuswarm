/**
 * Discord emoji catalog — per-account in-memory store for guild emoji, application
 * emoji, and observed name↔id pairs (spec DISCORD-SUPPORT-DESIGN §10.2/§10.3).
 *
 * Sendability rules (spec §10.3):
 *   sendable = target guild's own emoji ∪ application emoji
 *   observed pairs (scraped from incoming messages) are NOT sendable and never
 *   appear in emojiList(); they exist only so the normalizer can resolve :name:.
 *
 * The catalog is updated from:
 *   - Gateway READY (startup fetch of all guild emoji via fetchGuildEmoji)
 *   - GUILD_CREATE / GUILD_EMOJIS_UPDATE (live updates)
 *   - Inline message observations (extractEmojiObservations from the normalizer)
 *   - Application emoji fetch at startup (REST GET /applications/{id}/emojis)
 *
 * `normalizedKey` for custom Discord emoji (stored in the reactions table):
 *   `discord:<emojiSnowflake>` — same-named emoji in different guilds stay distinct.
 */

import type { EmojiEntry } from "../types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CatalogEmojiInfo {
  id: string;
  name: string;
  animated: boolean;
}

// ── EmojiCatalog ─────────────────────────────────────────────────────────────

/**
 * Per-account emoji catalog.
 *
 * - `guildEmoji`: guild-scoped emoji. Key = guild snowflake →
 *   Map<emoji snowflake, CatalogEmojiInfo>.
 * - `appEmoji`: application emoji (sendable everywhere). Key = emoji snowflake.
 * - `observedPairs`: emoji observed inline in incoming message content. Keyed by
 *   emoji snowflake (id) for dedup; NOT sendable (excluded from emojiList).
 *   Populated from `extractEmojiObservations` results at ingest.
 */
export class EmojiCatalog {
  private readonly guildEmoji = new Map<string, Map<string, CatalogEmojiInfo>>();
  private readonly appEmoji = new Map<string, CatalogEmojiInfo>();
  private readonly observedPairs = new Map<string, CatalogEmojiInfo>(); // id → info

  // ── Catalog updates ─────────────────────────────────────────────────────────

  /** Replace all emoji for a guild (called on READY + GUILD_EMOJIS_UPDATE). */
  setGuildEmoji(guildId: string, emojis: CatalogEmojiInfo[]): void {
    const map = new Map<string, CatalogEmojiInfo>();
    for (const e of emojis) {
      map.set(e.id, e);
    }
    this.guildEmoji.set(guildId, map);
  }

  /** Remove all emoji for a guild (bot left the guild). */
  clearGuildEmoji(guildId: string): void {
    this.guildEmoji.delete(guildId);
  }

  /** Replace all application emoji (called at startup if application_id is configured). */
  setAppEmoji(emojis: CatalogEmojiInfo[]): void {
    this.appEmoji.clear();
    for (const e of emojis) {
      this.appEmoji.set(e.id, e);
    }
  }

  /**
   * Record a custom emoji observed inline in an incoming message.
   * These are NOT sendable but populate the name→id map for rendering.
   * Keyed by id so the same emoji from two different messages only gets one row.
   */
  observeEmoji(id: string, name: string, animated: boolean): void {
    if (!this.observedPairs.has(id)) {
      this.observedPairs.set(id, { id, name, animated });
    }
  }

  // ── Sendable set ─────────────────────────────────────────────────────────────

  /**
   * Return the sendable emoji set for a target guild (target guild's emoji +
   * application emoji), as `EmojiEntry[]` for the `emoji_list` tool.
   *
   * No snowflakes are exposed to the model — only `:name:` + `animated` flag
   * (spec §10.3, §11 Q11). When `guildId` is undefined (DM target), only
   * application emoji are returned.
   *
   * Applies a stable sort: guild emoji first (alphabetical by name), then
   * application emoji (alphabetical by name).
   */
  getSendableEmoji(guildId: string | undefined): EmojiEntry[] {
    const entries: EmojiEntry[] = [];
    if (guildId) {
      const guild = this.guildEmoji.get(guildId);
      if (guild) {
        const sorted = [...guild.values()].sort((a, b) => a.name.localeCompare(b.name));
        for (const e of sorted) {
          entries.push({ shortcode: e.name, animated: e.animated });
        }
      }
    }
    // Application emoji (after guild emoji, also sorted)
    const appSorted = [...this.appEmoji.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const e of appSorted) {
      entries.push({ shortcode: e.name, animated: e.animated });
    }
    return entries;
  }

  // ── Emoji resolution for send ─────────────────────────────────────────────────

  /**
   * Resolve an emoji token for an outbound reaction or send.
   *
   * Input forms:
   *   - Unicode glyph (e.g. "👍"): returned as-is for direct use in Discord API.
   *   - `:name:` shortcode: resolve to `{id, name, animated}` from the sendable
   *     set (target guild first, then application emoji).
   *
   * Returns:
   *   - `{ kind: "unicode", emoji: string }` for unicode glyphs.
   *   - `{ kind: "custom", id: string, name: string, animated: boolean }` for resolved custom.
   *   - `null` if `:name:` cannot be resolved in the sendable set (not sendable).
   *
   * Observed pairs (not sendable) are explicitly excluded — the caller must surface
   * a clear error naming near-matches when the emoji isn't sendable (spec §10.3).
   */
  resolve(emoji: string, guildId: string | undefined): ResolvedEmoji | null {
    // Unicode: any string not matching `:name:` is treated as unicode.
    const customMatch = emoji.match(/^:([^:]+):$/);
    if (!customMatch) {
      return { kind: "unicode", emoji };
    }

    const name = customMatch[1]!;

    // Search target guild first
    if (guildId) {
      const guild = this.guildEmoji.get(guildId);
      if (guild) {
        for (const info of guild.values()) {
          if (info.name === name) {
            return { kind: "custom", id: info.id, name: info.name, animated: info.animated };
          }
        }
      }
    }

    // Then application emoji
    for (const info of this.appEmoji.values()) {
      if (info.name === name) {
        return { kind: "custom", id: info.id, name: info.name, animated: info.animated };
      }
    }

    // Not in sendable set
    return null;
  }

  /**
   * Find near-matches for an emoji name that is not sendable.
   * Used to generate a helpful error message (spec §10.3).
   * Searches the sendable set (guild + app) for names containing the query string.
   */
  nearMatches(name: string, guildId: string | undefined): string[] {
    const lower = name.toLowerCase();
    const candidates: string[] = [];
    if (guildId) {
      const guild = this.guildEmoji.get(guildId);
      if (guild) {
        for (const info of guild.values()) {
          if (info.name.toLowerCase().includes(lower)) candidates.push(`:${info.name}:`);
        }
      }
    }
    for (const info of this.appEmoji.values()) {
      if (info.name.toLowerCase().includes(lower)) candidates.push(`:${info.name}:`);
    }
    return candidates.slice(0, 5);
  }

  /**
   * Format a custom emoji for use in the Discord REST API reaction endpoint
   * (the `emoji` path component). Format: `name:id` (no angle brackets).
   */
  static formatForApi(id: string, name: string): string {
    return `${name}:${id}`;
  }

  /**
   * Build the `normalizedKey` for a Discord custom emoji as stored in the
   * reactions table (spec §10.1): `discord:<emojiSnowflake>`.
   */
  static normalizedKey(emojiId: string): string {
    return `discord:${emojiId}`;
  }
}

/** Result of {@link EmojiCatalog.resolve}. */
export type ResolvedEmoji =
  | { kind: "unicode"; emoji: string }
  | { kind: "custom"; id: string; name: string; animated: boolean };
