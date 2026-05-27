/**
 * Escape a string for use as XML element content.
 * Escapes all 5 XML special characters (&, <, >, ", ').
 * Safe for both element content and attribute values.
 */
export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
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
