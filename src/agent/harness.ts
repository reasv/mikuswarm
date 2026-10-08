/**
 * Harness-made transcript messages (ARCHITECTURE.md §8 "The work gate", §8i).
 *
 * The harness stamps a top-level `harness` marker (`HarnessMarker` in
 * `synthetic-calls.ts`, plus `forced_completion` and `refusal_withheld`) on every
 * message it writes itself: the records point's injected `read_session_record`
 * pairs, routing's `load_skill` preloads, the `tool_search` select that loads a
 * deferred injection target, the record turn's prompt and tool load, corrective
 * prompts. The marker is a plain JSON field, so it survives transcript
 * persistence and a resume from the stored transcript.
 *
 * Rule: nothing the harness injected ever counts as work or as the model's tool
 * use. Every predicate that judges whether a session did work, or what the
 * model called, reads tool calls through {@link modelToolCalls} (or skips
 * {@link isHarnessMade} messages), so the rule cannot drift between call sites.
 * Only the model's own calls count; a `read_session_record` the model chose to
 * call is work like any other read. Why: the decision model chose the
 * injection (at a lower bar than the agent's own), so it is not work the agent
 * did; a record turn over an injected record would only re-summarize it; and
 * counting injections lets too many sessions through the work gate.
 */

/** The harness marker of a message, or undefined for a message the model (or a user) wrote. */
export function harnessMarkerOf(message: unknown): { kind?: unknown; [key: string]: unknown } | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const marker = (message as { harness?: unknown }).harness;
  return marker !== null && typeof marker === "object" ? (marker as { kind?: unknown }) : undefined;
}

/** True for a message the harness wrote (it carries a `harness` marker). */
export function isHarnessMade(message: unknown): boolean {
  return harnessMarkerOf(message) !== undefined;
}

/** The marker's kind, when the message is harness-made and the kind is a string. */
export function harnessKindOf(message: unknown): string | undefined {
  const kind = harnessMarkerOf(message)?.kind;
  return typeof kind === "string" ? kind : undefined;
}

/** A `toolCall` block as stored in an assistant message. */
export interface ToolCallBlock {
  type: "toolCall";
  id?: string;
  name: string;
  arguments?: unknown;
}

/**
 * The tool calls the MODEL made in this message: the `toolCall` blocks of an
 * assistant message without a harness marker. Empty for harness-made messages
 * (injections, synthetic loads), user turns and tool results.
 */
export function modelToolCalls(message: unknown): ToolCallBlock[] {
  if (message === null || typeof message !== "object") return [];
  const m = message as { role?: unknown; content?: unknown };
  if (m.role !== "assistant" || !Array.isArray(m.content) || isHarnessMade(message)) return [];
  const out: ToolCallBlock[] = [];
  for (const block of m.content as unknown[]) {
    const b = block as { type?: unknown; name?: unknown } | null;
    if (b && b.type === "toolCall" && typeof b.name === "string") out.push(block as ToolCallBlock);
  }
  return out;
}
