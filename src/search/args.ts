/**
 * Argument tolerance shared by the chat-history search tools (`search_messages`,
 * `search_summaries`, ARCHITECTURE.md §9e).
 */

/**
 * Strip semantically-empty values from a tool call before interpreting it. Key
 * presence carries no intent: some models pad every optional schema field with "",
 * [], null, or 0 instead of omitting the ones they don't mean, so a value that
 * expresses no constraint must behave exactly like an omitted field. "" / [] / null
 * are dropped for every field; 0 is additionally dropped from level/min_level
 * (summary levels start at 1, so 0 cannot name a real level and a literal read
 * would silently match nothing).
 */
export function normalizeSearchArgs<T>(raw: Record<string, unknown>): T {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    if (v === "") continue;
    if (Array.isArray(v)) {
      const items = k === "level" ? v.filter((x) => x !== 0) : v;
      if (items.length === 0) continue;
      args[k] = items;
      continue;
    }
    if ((k === "level" || k === "min_level") && v === 0) continue;
    args[k] = v;
  }
  return args as T;
}

/**
 * The listed fields still present after normalization (i.e. carrying a real value),
 * plus the note to surface. Empty note when nothing was ignored. Used by each search
 * tool to tolerate filters that belong to the other tool: the search runs without
 * them and the result names them with the exact recourse — never a failed call.
 */
export function inapplicableFilters(
  args: Record<string, unknown>,
  fields: readonly string[],
  note: (names: string) => string,
): { ignored: string[]; note: string } {
  const ignored = fields.filter((f) => args[f] !== undefined);
  return { ignored, note: ignored.length > 0 ? note(ignored.join(", ")) : "" };
}
