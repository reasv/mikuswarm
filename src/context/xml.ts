/**
 * Escape a string for use as XML element content (text between tags).
 *
 * Escapes only the three characters that are structurally significant in
 * character data — `&`, `<`, `>` — and deliberately leaves `"` and `'`
 * untouched. Per the XML spec, quotes carry no special meaning in element
 * content; they only need escaping inside a same-quoted attribute value. Since
 * chat text is full of ordinary quotes, escaping them here only burned tokens
 * and made the body harder for the model to read (`he said &quot;hi&quot;`),
 * with zero injection-safety benefit — a user still cannot break out of a
 * `<message>…</message>` envelope without `<` or `&`, both of which are escaped.
 *
 * NOT safe for attribute values — those must use {@link escapeAttr}, which
 * additionally escapes the `"` delimiter.
 */
export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Escape a string for use in a double-quoted XML attribute value.
 * Escapes &, <, >, and " (the 4 characters that must be escaped in
 * double-quoted attribute values per XML spec).
 */
export function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
