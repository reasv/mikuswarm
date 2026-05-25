const DEFAULT_LIMIT = 4000;
const FENCE_PATTERN = /^(`{3,}|~{3,})/;

export function chunkMarkdownText(text: string, limit = DEFAULT_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let openFence: string | null = null;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push((openFence ? openFence + "\n" : "") + remaining);
      break;
    }

    let candidate = remaining.slice(0, limit);
    if (openFence) {
      const prefix = openFence + "\n";
      candidate = remaining.slice(0, limit - prefix.length);
    }

    const splitIdx = findSplitPoint(candidate, openFence);
    let chunk = candidate.slice(0, splitIdx);
    let advance = splitIdx;

    if (openFence) {
      chunk = openFence + "\n" + chunk;
    }

    const fenceState = trackFences(candidate.slice(0, splitIdx), openFence);
    if (fenceState.insideFence) {
      chunk += "\n" + fenceState.closeMarker!;
      openFence = fenceState.reopenMarker!;
    } else {
      openFence = null;
    }

    chunks.push(chunk);
    remaining = remaining.slice(advance).replace(/^\n/, "");
  }

  return chunks;
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

  for (const line of lines) {
    const match = FENCE_PATTERN.exec(line.trim());
    if (match) {
      if (inside && currentMarker && match[1][0] === currentMarker[0] && match[1].length >= currentMarker.length) {
        inside = false;
        currentMarker = null;
      } else if (!inside) {
        inside = true;
        currentMarker = match[1];
      }
    }
  }

  if (inside && currentMarker) {
    const closeMarker = currentMarker;
    return {
      insideFence: true,
      closeMarker,
      reopenMarker: currentMarker,
    };
  }
  return { insideFence: false, closeMarker: null, reopenMarker: null };
}
