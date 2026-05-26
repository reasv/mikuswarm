const DEFAULT_LIMIT = 4000;
const FENCE_PATTERN = /^(`{3,}|~{3,})(.*)/;

export function chunkMarkdownText(text: string, limit = DEFAULT_LIMIT): string[] {
  if (text.length === 0) return [];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let openFence: string | null = null;

  while (remaining.length > 0) {
    const prefixLen = openFence ? openFence.length + 1 : 0;
    if (remaining.length + prefixLen <= limit) {
      chunks.push((openFence ? openFence + "\n" : "") + remaining);
      break;
    }

    // Reserve space for prefix (reopen marker) and suffix (close marker)
    let reserved = 0;
    if (openFence) {
      const prefix = openFence + "\n";
      // Suffix: "\n" + bare fence chars (no info string needed for closing)
      const closeSuffix = "\n" + extractBareMarker(openFence);
      reserved = prefix.length + closeSuffix.length;
    }
    let candidate = remaining.slice(0, Math.max(1, limit - reserved));

    let splitIdx = findSplitPoint(candidate, openFence);
    let chunk = candidate.slice(0, splitIdx);
    let advance = splitIdx;
    if (advance <= 0) advance = Math.min(remaining.length, limit);

    if (openFence) {
      chunk = openFence + "\n" + chunk;
    }

    let fenceState = trackFences(candidate.slice(0, splitIdx), openFence);

    // If a fence opened within this chunk and openFence was null, no space
    // was reserved for the close marker. Retry with reduced available space.
    if (fenceState.insideFence && !openFence) {
      const closeSuffix = "\n" + fenceState.closeMarker!;
      reserved = closeSuffix.length;
      candidate = remaining.slice(0, Math.max(1, limit - reserved));
      splitIdx = findSplitPoint(candidate, null);
      chunk = candidate.slice(0, splitIdx);
      advance = splitIdx;
      if (advance <= 0) advance = Math.min(remaining.length, limit);
      fenceState = trackFences(candidate.slice(0, splitIdx), null);
    }

    if (fenceState.insideFence) {
      chunk += "\n" + fenceState.closeMarker!;
      openFence = fenceState.reopenMarker!;
    } else {
      openFence = null;
    }

    chunks.push(chunk);
    remaining = remaining.slice(advance).replace(/^\n+/, "");
  }

  return chunks;
}

/** Extract the bare backtick/tilde run from a fence marker (strips info string). */
function extractBareMarker(marker: string): string {
  const m = /^(`{3,}|~{3,})/.exec(marker);
  return m ? m[1] : marker;
}

function findSplitPoint(text: string, _openFence: string | null): number {
  // Try paragraph break
  const paraIdx = findLastOccurrence(text, "\n\n");
  if (paraIdx > text.length * 0.3) {
    return paraIdx;
  }

  // Try newline break (but not inside a code fence)
  const nlIdx = findLastNewline(text);
  if (nlIdx > text.length * 0.3) {
    return nlIdx;
  }

  // Try word boundary
  const wsIdx = findLastWhitespace(text);
  if (wsIdx > text.length * 0.3) {
    return wsIdx;
  }

  // Last resort: hard break at limit
  return text.length;
}

function findLastOccurrence(text: string, needle: string): number {
  const idx = text.lastIndexOf(needle);
  return idx === -1 ? -1 : idx;
}

function findLastNewline(text: string): number {
  const idx = text.lastIndexOf("\n");
  return idx === -1 ? -1 : idx;
}

function findLastWhitespace(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === " " || text[i] === "\t") return i;
  }
  return -1;
}

interface FenceState {
  insideFence: boolean;
  closeMarker: string | null;
  reopenMarker: string | null;
}

function trackFences(chunk: string, initialFence: string | null): FenceState {
  const lines = chunk.split("\n");
  let inside = initialFence !== null;
  let currentMarker = initialFence;
  let currentBareMarker = initialFence ? extractBareMarker(initialFence) : null;

  for (const line of lines) {
    const match = FENCE_PATTERN.exec(line.trim());
    if (match) {
      const bareRun = match[1];
      if (inside && currentBareMarker && bareRun[0] === currentBareMarker[0] && bareRun.length >= currentBareMarker.length) {
        inside = false;
        currentMarker = null;
        currentBareMarker = null;
      } else if (!inside) {
        inside = true;
        // Capture full marker including info string for reopening
        const infoString = match[2]?.trim() ?? "";
        currentBareMarker = bareRun;
        currentMarker = infoString ? bareRun + infoString : bareRun;
      }
    }
  }

  if (inside && currentMarker) {
    // Close uses bare backticks/tildes; reopen includes the info string
    return {
      insideFence: true,
      closeMarker: currentBareMarker!,
      reopenMarker: currentMarker,
    };
  }
  return { insideFence: false, closeMarker: null, reopenMarker: null };
}
