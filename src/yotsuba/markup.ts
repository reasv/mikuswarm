/**
 * Yotsuba (4chan) comment HTML → plain text conversion.
 * (spec/YOTSUBA-SUPPORT.md §4.4)
 *
 * Converts the `com` field from a 4chan API post to plain text plus structural
 * data (same-thread quotes, dead quotes, cross-thread quotes). Reference
 * annotations like (OP) / (not shown) are NOT baked in here — they depend on
 * which posts a particular view shows, so the renderer adds them at render time.
 *
 * All input is untrusted. The converter strips HTML tags and decodes entities
 * but does not HTML-encode output (the caller escapes output for its target
 * format).
 */

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ConvertedComment {
  /** Plain-text body. */
  text: string;
  /** Same-thread quotelink numbers (>>123), only existing posts. */
  quotes: number[];
  /** Quotelinks to deleted/missing posts. */
  deadQuotes?: number[];
  /** Cross-thread quotelinks as ">>>/b/N" strings. */
  crossQuotes?: string[];
}

// ---------------------------------------------------------------------------
// Main converter
// ---------------------------------------------------------------------------

/**
 * Convert a 4chan API `com` HTML string to plain text plus quote metadata.
 *
 * The conversion table (spec §4.4):
 *   <br>                    → newline
 *   <wbr>                   → removed (no whitespace)
 *   same-thread quotelink   → ">>N" (collected into `quotes`)
 *   cross-thread quotelink  → ">>>/b/N" (collected into `crossQuotes`)
 *   greentext span          → kept, leading > preserved
 *   deadlink span           → ">>N" (collected into `deadQuotes`)
 *   <s> spoiler             → [spoiler]…[/spoiler]
 *   <pre class="prettyprint"> → ```\n…\n``` (fenced code)
 *   [math]…[/math]          → verbatim
 *   [eqn]…[/eqn]            → verbatim
 *   red mod text (strong.warning-text or span.banned) → [mod: …]
 *   other tags              → stripped, text kept
 *   HTML entities           → decoded
 */
export function convertComment(html: string | undefined | null): ConvertedComment {
  if (!html) return { text: "", quotes: [] };

  const quotes: number[] = [];
  const deadQuotes: number[] = [];
  const crossQuotes: string[] = [];

  // We walk through the HTML with a simple state machine. We don't use a full
  // DOM parser to keep the dependency surface minimal and the conversion fast.
  const result = processHtml(html, quotes, deadQuotes, crossQuotes);

  return {
    text: result,
    quotes,
    ...(deadQuotes.length > 0 ? { deadQuotes } : {}),
    ...(crossQuotes.length > 0 ? { crossQuotes } : {}),
  };
}

// ---------------------------------------------------------------------------
// HTML processing
// ---------------------------------------------------------------------------

/**
 * Walk the HTML string token by token, transforming per the spec table.
 * Returns the plain-text result; mutates the three collector arrays.
 */
function processHtml(
  html: string,
  quotes: number[],
  deadQuotes: number[],
  crossQuotes: string[],
): string {
  let out = "";
  let i = 0;
  const len = html.length;

  while (i < len) {
    if (html[i] === "<") {
      // Find closing >
      const end = html.indexOf(">", i + 1);
      if (end === -1) {
        // Unterminated tag — treat as literal
        out += html[i];
        i++;
        continue;
      }
      const tag = html.slice(i, end + 1);
      const inner = html.slice(i + 1, end).trim();
      i = end + 1;

      // Self-closing / void elements
      if (/^<br\s*\/?>$/i.test(tag)) {
        out += "\n";
        continue;
      }
      if (/^<wbr\s*\/?>$/i.test(tag)) {
        // removed — no whitespace
        continue;
      }

      // Quotelink: <a class="quotelink" href="...">
      if (/^<a\b/i.test(tag) && /class="quotelink"/i.test(inner)) {
        const href = /href="([^"]+)"/.exec(inner)?.[1] ?? "";
        // Consume the text content and closing </a>
        const closeA = html.indexOf("</a>", i);
        const text = closeA >= 0 ? html.slice(i, closeA) : "";
        i = closeA >= 0 ? closeA + 4 : i;
        // Determine ref type from href
        if (href.startsWith("#p")) {
          // Same-thread quotelink: href="#p123"
          const no = parseInt(href.slice(2), 10);
          if (Number.isFinite(no)) {
            quotes.push(no);
            out += `>>${no}`;
          } else {
            out += decodeEntities(text);
          }
        } else {
          // Cross-thread: href="/g/thread/456#p789" or "/g/thread/456"
          const crossMatch = /^\/([a-z0-9]{1,10})\/thread\/\d+(?:#p(\d+))?$/.exec(href);
          if (crossMatch) {
            const board = crossMatch[1];
            const postNo = crossMatch[2] ? parseInt(crossMatch[2], 10) : undefined;
            const ref = postNo != null ? `>>>/b/${postNo}`.replace("b", board) : `>>>/b/`.replace("b", board);
            const finalRef = postNo != null ? `>>>/${board}/${postNo}` : `>>>/${board}/`;
            crossQuotes.push(finalRef);
            out += finalRef;
          } else {
            out += decodeEntities(text);
          }
        }
        continue;
      }

      // Deadlink: <span class="deadlink">>>N</span>
      if (/^<span\b/i.test(tag) && /class="deadlink"/i.test(inner)) {
        const closeSpan = html.indexOf("</span>", i);
        const text = closeSpan >= 0 ? html.slice(i, closeSpan) : "";
        i = closeSpan >= 0 ? closeSpan + 7 : i;
        // text is typically ">>&gt;N" or ">>N"
        const decodedText = decodeEntities(text);
        const noMatch = />>(\d+)/.exec(decodedText);
        if (noMatch) {
          const no = parseInt(noMatch[1], 10);
          deadQuotes.push(no);
          out += `>>${no}`;
        } else {
          out += decodedText;
        }
        continue;
      }

      // Greentext: <span class="quote">
      if (/^<span\b/i.test(tag) && /class="quote"/.test(inner)) {
        // Just consume; the text content (including the leading >) comes through
        // naturally from the rest of the loop.
        continue;
      }

      // Spoiler: <s>…</s>
      if (/^<s>$/i.test(tag)) {
        const closeS = html.indexOf("</s>", i);
        const text = closeS >= 0 ? html.slice(i, closeS) : "";
        i = closeS >= 0 ? closeS + 4 : i;
        out += `[spoiler]${processHtml(text, quotes, deadQuotes, crossQuotes)}[/spoiler]`;
        continue;
      }

      // Code block: <pre class="prettyprint">
      if (/^<pre\b/i.test(tag) && /class="prettyprint"/.test(inner)) {
        const closePre = html.indexOf("</pre>", i);
        const text = closePre >= 0 ? html.slice(i, closePre) : "";
        i = closePre >= 0 ? closePre + 6 : i;
        // Process inner HTML to decode entities but strip tags inside code too
        const codeText = processHtml(text, [], [], []);
        out += "```\n" + codeText + "\n```";
        continue;
      }

      // Mod/ban text: <span class="warning-text"> or <strong class="warning-text">
      // 4chan typically wraps them in these classes.
      if (
        (/^<span\b/i.test(tag) || /^<strong\b/i.test(tag)) &&
        (/class="[^"]*warning[-_]text[^"]*"/.test(inner) || /class="[^"]*banned[^"]*"/.test(inner))
      ) {
        const tagName = /^<(span|strong)\b/i.exec(tag)?.[1]?.toLowerCase() ?? "span";
        const closeIdxFromI = html.indexOf(`</${tagName}>`, i);
        const text = closeIdxFromI >= 0 ? html.slice(i, closeIdxFromI) : "";
        i = closeIdxFromI >= 0 ? closeIdxFromI + tagName.length + 3 : i;
        const inner2 = processHtml(text, quotes, deadQuotes, crossQuotes);
        out += `[mod: ${inner2}]`;
        continue;
      }

      // Skip all other tags (strip tag, keep text)
      // Any closing/opening tag we don't handle — just skip it.
      continue;
    } else if (html[i] === "&") {
      // HTML entity
      const semi = html.indexOf(";", i + 1);
      if (semi >= 0 && semi - i <= 12) {
        const entity = html.slice(i, semi + 1);
        out += decodeEntity(entity);
        i = semi + 1;
      } else {
        out += html[i];
        i++;
      }
    } else {
      out += html[i];
      i++;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Entity decoding
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#039;": "'",
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

function decodeEntity(entity: string): string {
  if (entity in NAMED_ENTITIES) return NAMED_ENTITIES[entity];
  // Numeric: &#N; or &#xN;
  const numMatch = /^&#([xX]?)([0-9a-fA-F]+);$/.exec(entity);
  if (numMatch) {
    const code = parseInt(numMatch[2], numMatch[1] ? 16 : 10);
    if (Number.isFinite(code)) return String.fromCodePoint(code);
  }
  // Unknown entity — return as-is
  return entity;
}

function decodeEntities(s: string): string {
  return s.replace(/&[^;]{1,10};/g, decodeEntity);
}

// ---------------------------------------------------------------------------
// Render-time annotation helper
// ---------------------------------------------------------------------------

/**
 * Annotate `>>N` references in an already-converted comment text.
 *
 * Adds suffix annotations in parentheses after each `>>N`:
 *   - `(OP)` when N is the OP number
 *   - `(not shown)` when N is not in `shownNos` and not a dead quote
 *   - `(deleted)` when N is in `deadQuoteNos`
 *   - `(other thread)` for cross-thread `>>>/b/N` references
 *   - nothing when N IS shown (bare reference)
 *
 * This function operates on already-converted plain text; it does not re-parse
 * HTML. For cross-thread refs (`>>>/b/N`), the annotation is always `(other thread)`.
 *
 * @param text         The converted comment text.
 * @param shownNos     Set of post numbers shown in this view.
 * @param opNo         The OP post number of this thread.
 * @param deadQuoteNos Set of dead-quote post numbers.
 */
export function annotateQuotes(
  text: string,
  shownNos: ReadonlySet<number>,
  opNo: number,
  deadQuoteNos: ReadonlySet<number>,
): string {
  // Annotate cross-thread refs first (>>>/ prefix)
  let result = text.replace(/>>>\/[a-z0-9]{1,10}\/\d+/g, (ref) => `${ref} (other thread)`);

  // Annotate same-thread refs (>>N, not preceded by >)
  // We match >>N that is not part of >>>/
  result = result.replace(/(?<!>)>>(\d+)/g, (full, numStr) => {
    const no = parseInt(numStr, 10);
    if (deadQuoteNos.has(no)) return `${full} (deleted)`;
    if (no === opNo) return `${full} (OP)`;
    if (!shownNos.has(no)) return `${full} (not shown)`;
    return full;
  });

  return result;
}
