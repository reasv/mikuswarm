const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

const MEDIA_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg",
  ".mp4", ".webm", ".mov",
  ".mp3", ".ogg", ".wav", ".flac",
]);

const IMAGE_HOST_PATTERNS = [
  /^i\.imgur\.com\//,
  /^pbs\.twimg\.com\//,
  /^cdn\.discordapp\.com\/attachments\//,
  /^media\.discordapp\.net\/attachments\//,
];

export function extractLinkedMediaUrls(bodyText: string, excludeUrls?: Set<string>): string[] {
  const matches = bodyText.match(URL_REGEX);
  if (!matches) return [];

  const seen = new Set<string>();
  const results: string[] = [];

  for (const rawUrl of matches) {
    if (seen.has(rawUrl)) continue;
    seen.add(rawUrl);
    if (excludeUrls?.has(rawUrl)) continue;

    try {
      const parsed = new URL(rawUrl);
      const pathLower = parsed.pathname.toLowerCase();
      const ext = pathLower.includes(".") ? "." + pathLower.split(".").pop()! : "";

      if (MEDIA_EXTENSIONS.has(ext)) {
        results.push(rawUrl);
        continue;
      }

      const hostPath = parsed.host + parsed.pathname;
      if (IMAGE_HOST_PATTERNS.some((pattern) => pattern.test(hostPath))) {
        results.push(rawUrl);
      }
    } catch {
      // invalid URL, skip
    }
  }

  return results;
}
