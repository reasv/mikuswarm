import { formatAgentTimestamp } from "../time/index.js";
import type { FxApiTweet, XTweetNode, XTweetPayload } from "./types.js";

/**
 * Shared payload-building, flat-text rendering and truncation helpers
 * (spec/FXTWITTER-ENRICHMENT.md §4/§6/§7). Used by the enrichment FxTwitter
 * stage and the `x_fetch` tool so both render tweets the same way.
 */

/**
 * Truncate a tweet text field on a char boundary. The stored payload text
 * stays clean (`…` only); the rich renderer appends the x_fetch hint off the
 * `truncated` flag so the FTS-indexed flat description isn't polluted with
 * renderer chrome.
 */
export function truncateTweetText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, maxChars - 1))}…`, truncated: true };
}

/** "12 replies · 340 retweets · 4,521 likes · 120,034 views" (set fields only). */
export function formatStatsLine(stats?: XTweetNode["stats"]): string | undefined {
  if (!stats) return undefined;
  const parts: string[] = [];
  const fmt = (n: number) => n.toLocaleString("en-US");
  if (stats.replies !== undefined) parts.push(`${fmt(stats.replies)} replies`);
  if (stats.retweets !== undefined) parts.push(`${fmt(stats.retweets)} retweets`);
  if (stats.likes !== undefined) parts.push(`${fmt(stats.likes)} likes`);
  if (stats.views !== undefined) parts.push(`${fmt(stats.views)} views`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Build one payload node from an FxTwitter tweet object — text/stats/poll/
 * note only; media slots are filled in by the enrichment stage after the
 * downloads settle (they reference minted asset ids). `quote` is walked one
 * level deep; a deeper quote is represented only by its URL inside the inner
 * text (FxTwitter's own behavior).
 */
export function buildTweetNode(tweet: FxApiTweet, maxTextChars: number, depth = 0): XTweetNode {
  const node: XTweetNode = { id: tweet.id ?? "" };
  if (tweet.url) node.url = tweet.url;
  if (tweet.author?.name) node.authorName = tweet.author.name;
  if (tweet.author?.screen_name) node.authorHandle = tweet.author.screen_name;
  if (typeof tweet.created_timestamp === "number") {
    node.createdAtMs = tweet.created_timestamp * 1000;
  }
  if (tweet.text) {
    const { text, truncated } = truncateTweetText(tweet.text, maxTextChars);
    node.text = text;
    if (truncated) node.textTruncated = true;
  }
  const stats: NonNullable<XTweetNode["stats"]> = {};
  if (typeof tweet.replies === "number") stats.replies = tweet.replies;
  if (typeof tweet.retweets === "number") stats.retweets = tweet.retweets;
  if (typeof tweet.likes === "number") stats.likes = tweet.likes;
  if (typeof tweet.views === "number") stats.views = tweet.views;
  if (Object.keys(stats).length > 0) node.stats = stats;
  if (tweet.poll?.choices && tweet.poll.choices.length > 0) {
    node.poll = {
      choices: tweet.poll.choices.map((c) => ({
        label: c.label ?? "",
        percentage: c.percentage,
        count: c.count,
      })),
      totalVotes: tweet.poll.total_votes,
      endsAt: tweet.poll.ends_at,
    };
  }
  if (tweet.community_note) {
    const { text, truncated } = truncateTweetText(tweet.community_note, maxTextChars);
    node.communityNote = text;
    if (truncated) node.communityNoteTruncated = true;
  }
  if (tweet.quote && depth === 0) {
    node.quote = buildTweetNode(tweet.quote, maxTextChars, depth + 1);
  }
  return node;
}

/**
 * Flat-text rendering of the whole payload — the `link_previews.description`
 * column. This is the compact-tier-less fallback rendering AND what the
 * chat-search FTS indexes (`chat_index` builds linkText from
 * title/description), so tweet content stays searchable with zero
 * search-layer changes.
 */
export function renderFlatDescription(payload: XTweetPayload): string {
  return renderFlatNode(payload.tweet, false);
}

function renderFlatNode(node: XTweetNode, isQuote: boolean): string {
  const lines: string[] = [];
  const handle = node.authorHandle ? `@${node.authorHandle}` : undefined;
  const who = [node.authorName, handle ? `(${handle})` : undefined].filter(Boolean).join(" ");
  const when = node.createdAtMs !== undefined ? formatAgentTimestamp(node.createdAtMs) : undefined;
  const header = [isQuote ? "Quoting" : undefined, who || undefined, when ? `· ${when}` : undefined]
    .filter(Boolean)
    .join(" ");
  if (header) lines.push(header);
  if (node.text) lines.push(node.text);
  const stats = formatStatsLine(node.stats);
  if (stats) lines.push(stats);
  if (node.poll) {
    const pollLines = node.poll.choices.map((c) => {
      const pct = c.percentage !== undefined ? ` — ${c.percentage}%` : "";
      const count = c.count !== undefined ? ` (${c.count.toLocaleString("en-US")})` : "";
      return `${c.label}${pct}${count}`;
    });
    const total = node.poll.totalVotes !== undefined ? ` (${node.poll.totalVotes.toLocaleString("en-US")} votes)` : "";
    lines.push(`Poll${total}: ${pollLines.join(" | ")}`);
  }
  if (node.communityNote) lines.push(`Community note: ${node.communityNote}`);
  if (node.quote) {
    lines.push("");
    lines.push(renderFlatNode(node.quote, true));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// x_fetch document assembly (§7.1)
// ---------------------------------------------------------------------------

/** One entry of the x_fetch numbered media listing, addressable by `index`. */
export interface XFetchMediaItem {
  /** 1-based, stable across tweet + quote (tweet media first). */
  index: number;
  origin: "tweet" | "quote";
  kind: "photo" | "video" | "gif";
  /** Direct media URL (photo at original resolution / mp4). */
  url: string;
  /** Video/GIF poster frame — what view_media returns for non-photos. */
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  altText?: string;
  format?: string;
}

export interface XFetchDocument {
  text: string;
  media: XFetchMediaItem[];
}

/**
 * Build the canonical x_fetch text document: header (author, handle, time,
 * stats), FULL tweet text, poll/community-note blocks, the numbered media
 * listing, then the quoted tweet in the same layout. `maxTotalChars` bounds
 * the assembled document (the tool windows over it via offset/max_chars).
 */
export function buildTweetDocument(tweet: FxApiTweet, maxTotalChars: number): XFetchDocument {
  const media = collectMediaItems(tweet);
  const sections: string[] = [renderDocumentNode(tweet, media, "tweet")];
  if (tweet.quote) {
    sections.push("", "── Quoted tweet ──", renderDocumentNode(tweet.quote, media, "quote"));
  }
  let text = sections.join("\n");
  if (text.length > maxTotalChars) {
    text = `${text.slice(0, Math.max(0, maxTotalChars - 1))}…`;
  }
  return { text, media };
}

function collectMediaItems(tweet: FxApiTweet): XFetchMediaItem[] {
  const items: XFetchMediaItem[] = [];
  for (const origin of ["tweet", "quote"] as const) {
    const node = origin === "tweet" ? tweet : tweet.quote;
    if (!node?.media) continue;
    for (const photo of node.media.photos ?? []) {
      if (!photo.url) continue;
      items.push({
        index: items.length + 1,
        origin,
        kind: "photo",
        url: photo.url,
        width: photo.width,
        height: photo.height,
        altText: photo.altText,
      });
    }
    for (const video of node.media.videos ?? []) {
      if (!video.url) continue;
      items.push({
        index: items.length + 1,
        origin,
        kind: video.type === "gif" ? "gif" : "video",
        url: video.url,
        thumbnailUrl: video.thumbnail_url,
        durationSeconds: video.duration,
        format: video.format,
      });
    }
  }
  return items;
}

function renderDocumentNode(
  tweet: FxApiTweet,
  allMedia: XFetchMediaItem[],
  origin: "tweet" | "quote",
): string {
  const lines: string[] = [];
  const handle = tweet.author?.screen_name ? `@${tweet.author.screen_name}` : undefined;
  const who = [tweet.author?.name, handle ? `(${handle})` : undefined].filter(Boolean).join(" ");
  const when = typeof tweet.created_timestamp === "number"
    ? formatAgentTimestamp(tweet.created_timestamp * 1000)
    : undefined;
  lines.push([who || "(unknown author)", when ? `· ${when}` : undefined].filter(Boolean).join(" "));
  if (tweet.url) lines.push(tweet.url);
  const stats = formatStatsLine({
    replies: tweet.replies,
    retweets: tweet.retweets,
    likes: tweet.likes,
    views: tweet.views,
  });
  if (stats) lines.push(stats);
  lines.push("");
  lines.push(tweet.text ?? "(no text)");
  if (tweet.poll?.choices && tweet.poll.choices.length > 0) {
    lines.push("");
    const total = tweet.poll.total_votes !== undefined
      ? ` (${tweet.poll.total_votes.toLocaleString("en-US")} votes)`
      : "";
    lines.push(`Poll${total}:`);
    for (const choice of tweet.poll.choices) {
      const pct = choice.percentage !== undefined ? ` — ${choice.percentage}%` : "";
      const count = choice.count !== undefined ? ` (${choice.count.toLocaleString("en-US")})` : "";
      lines.push(`  ${choice.label ?? ""}${pct}${count}`);
    }
  }
  if (tweet.community_note) {
    lines.push("", `Community note: ${tweet.community_note}`);
  }
  const nodeMedia = allMedia.filter((item) => item.origin === origin);
  if (nodeMedia.length > 0) {
    lines.push("", "Media:");
    for (const item of nodeMedia) {
      const dims = item.width && item.height ? ` ${item.width}x${item.height}` : "";
      const dur = item.durationSeconds !== undefined ? ` ${item.durationSeconds}s` : "";
      const alt = item.altText ? ` alt="${item.altText}"` : "";
      lines.push(`  [${item.index}] ${item.kind}${dims}${dur}${alt} ${item.url}`);
    }
  }
  return lines.join("\n");
}
