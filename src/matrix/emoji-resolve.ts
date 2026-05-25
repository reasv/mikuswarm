import type { MatrixNativeClient } from "./native-client.js";
import type { MatrixInboundEvent } from "./native-types.js";

export function extractCustomEmojiUsageFromFormattedBody(
  formattedBody: string,
): Array<{ mxcUrl: string; shortcode: string }> {
  const imgTagPattern = /<img\b[^>]*>/gis;
  const attrPattern =
    /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gis;
  const entries = new Map<string, { mxcUrl: string; shortcode: string }>();

  for (const match of formattedBody.matchAll(imgTagPattern)) {
    const rawTag = match[0] ?? "";
    if (!/data-mx-emoticon/i.test(rawTag)) {
      continue;
    }

    let mxcUrl = "";
    let shortcode = "";
    let title = "";
    for (const captures of rawTag.matchAll(attrPattern)) {
      const name = (captures[1] ?? "").toLowerCase();
      const value = captures[2] ?? captures[3] ?? "";
      if ((name === "src" || name === "data-mx-src") && !mxcUrl) {
        mxcUrl = value;
      } else if (name === "alt" && !shortcode) {
        shortcode = value;
      } else if (name === "title" && !title) {
        title = value;
      }
    }

    shortcode = normalizeShortcode(shortcode || title);
    if (!mxcUrl.startsWith("mxc://") || !shortcode.startsWith(":")) {
      continue;
    }
    entries.set(`${shortcode} ${mxcUrl}`, { mxcUrl, shortcode });
  }

  return [...entries.values()];
}

export function recordInboundEmojiUsage(
  client: MatrixNativeClient,
  event: MatrixInboundEvent,
): void {
  const formattedBody = event.formattedBody?.trim();
  if (!formattedBody) return;
  const emoji = extractCustomEmojiUsageFromFormattedBody(formattedBody);
  if (emoji.length === 0) return;
  client.recordCustomEmojiUsage({
    roomId: event.roomId,
    observedAtMs: Date.parse(event.timestamp),
    emoji,
  });
}

function normalizeShortcode(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^:[^:\s]+:$/.test(trimmed)) return trimmed;
  if (/^[A-Za-z0-9_+\-]+$/.test(trimmed)) return `:${trimmed}:`;
  return trimmed;
}
