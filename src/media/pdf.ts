/**
 * Generic PDF text extraction.
 * (spec/YOTSUBA-SUPPORT.md §7.4)
 *
 * Uses `unpdf` (a pure-JS wrapper around pdfjs-dist that runs in Node 24
 * without canvas or native builds). Extracts text from a range of pages up
 * to a character cap, reports page count, and detects PDFs with no text
 * layer (scanned images).
 *
 * Why unpdf:
 *   - Explicitly mentioned in the spec as a suitable choice.
 *   - Pure JavaScript, no native build or canvas required.
 *   - Works with Node 24 ESM out of the box.
 *   - Thin wrapper over pdfjs-dist that avoids canvas API dependency.
 */

import { getDocumentProxy, extractText } from "unpdf";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PdfExtractOptions {
  /**
   * Maximum number of characters to extract before stopping.
   * Default: 8 000 (matching the spec default `pdf_max_chars`).
   */
  maxChars?: number;
  /**
   * 1-based page range to extract, e.g. "1-6" or "7-12" or "3".
   * Default: start from page 1.
   */
  pages?: string;
}

export interface PdfExtractResult {
  /** Extracted text, truncated to `maxChars` when necessary. */
  text: string;
  /** Total pages in the document. */
  totalPages: number;
  /** 1-based first page extracted. */
  fromPage: number;
  /** 1-based last page extracted (inclusive). */
  toPage: number;
  /** True when `maxChars` was reached before the end of the range. */
  truncated: boolean;
  /** True when the document has no extractable text layer (likely a scanned PDF). */
  noTextLayer: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Extract text from a PDF buffer.
 *
 * @param data    Buffer (or Uint8Array) containing the PDF.
 * @param opts    Options: maxChars, pages range.
 */
export async function extractPdfText(
  data: Buffer | Uint8Array,
  opts: PdfExtractOptions = {},
): Promise<PdfExtractResult> {
  const maxChars = opts.maxChars ?? 8_000;

  // Load the document.
  const proxy = await getDocumentProxy(new Uint8Array(data));
  const totalPages = proxy.numPages;

  // Parse page range.
  const { from: fromPage, to: toPage } = parsePageRange(opts.pages, totalPages);

  const parts: string[] = [];
  let totalExtracted = 0;
  let truncated = false;
  let anyText = false;

  for (let pageNo = fromPage; pageNo <= toPage; pageNo++) {
    const page = await proxy.getPage(pageNo);
    const content = await page.getTextContent();
    const items = content.items as Array<{ str?: string; hasEOL?: boolean }>;

    const lines: string[] = [];
    let lineBuffer = "";
    for (const item of items) {
      const str = item.str ?? "";
      if (str.trim()) anyText = true;
      lineBuffer += str;
      if (item.hasEOL) {
        lines.push(lineBuffer);
        lineBuffer = "";
      }
    }
    if (lineBuffer) lines.push(lineBuffer);

    const pageText = lines.join("\n");
    const remaining = maxChars - totalExtracted;
    if (pageText.length >= remaining) {
      parts.push(pageText.slice(0, remaining));
      totalExtracted += remaining;
      truncated = true;
      break;
    }
    parts.push(pageText);
    totalExtracted += pageText.length;
  }

  const text = parts.join("\n\n").trimEnd();

  return {
    text,
    totalPages,
    fromPage,
    toPage: truncated ? toPage : toPage,
    truncated,
    noTextLayer: !anyText && totalPages > 0,
  };
}

// ---------------------------------------------------------------------------
// Page range parsing
// ---------------------------------------------------------------------------

/**
 * Parse a page range string (e.g. "1-6", "7-12", "3") into 1-based
 * {from, to} inclusive, clamped to [1, totalPages].
 */
export function parsePageRange(
  rangeStr: string | undefined,
  totalPages: number,
): { from: number; to: number } {
  if (!rangeStr) return { from: 1, to: totalPages };

  const parts = rangeStr.trim().split("-").map((s) => parseInt(s.trim(), 10));
  let from = isFinite(parts[0]!) ? parts[0]! : 1;
  let to = parts.length >= 2 && isFinite(parts[1]!) ? parts[1]! : from;

  from = Math.max(1, Math.min(from, totalPages));
  to = Math.max(from, Math.min(to, totalPages));
  return { from, to };
}
