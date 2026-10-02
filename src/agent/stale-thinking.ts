/**
 * Stale-thinking omission (config `[models.<name>.compat] drop_stale_thinking`).
 *
 * Some models sign each thinking block against the request prefix that produced
 * it — the system prompt, the `tools` array and every earlier message — and
 * reject a later request that replays the block after that prefix changed.
 * MikuSwarm keeps a session's prefix append-only (frozen base + live rollout),
 * with two exceptions:
 *
 * - a resumed session re-renders the system prompt, and
 * - a dynamic tool load changes the `tools` array (ARCHITECTURE.md §10
 *   Transport) unless the member declares its whole catalog up front
 *   (`declare_deferred_tools`); such a member passes `atToolLoads: false`.
 *
 * For a member that opts in, thinking blocks produced before the latest such
 * change are left out of the outgoing history. Blocks produced after it are
 * replayed unchanged, so the model keeps its reasoning for the rest of the run.
 * The persisted transcript is never touched: this only shapes one request.
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

/** A tool result that made tools available (pi-ai's `addedToolNames` contract). */
function isToolLoadPoint(message: Message): boolean {
  if (message.role !== "toolResult") return false;
  const added = (message as { addedToolNames?: unknown }).addedToolNames;
  return Array.isArray(added) && added.length > 0;
}

export interface StaleThinkingOptions {
  /** The transcript a resumed session started from; its turns are always stale. */
  resumed?: WeakSet<object>;
  /** Whether a tool load changes this member's request prefix. Default true. */
  atToolLoads?: boolean;
}

/**
 * Return `messages` with the thinking blocks of stale assistant turns removed.
 * A turn is stale when it belongs to `resumed`, or (with `atToolLoads`) when it
 * precedes the last tool-load point. Returns the input array itself when
 * nothing had to change.
 */
export function dropStaleThinking(messages: Message[], options: StaleThinkingOptions = {}): Message[] {
  const { resumed, atToolLoads = true } = options;
  let lastLoad = -1;
  for (let i = messages.length - 1; atToolLoads && i >= 0; i--) {
    if (isToolLoadPoint(messages[i]!)) {
      lastLoad = i;
      break;
    }
  }
  let changed = false;
  const out = messages.map((message, index) => {
    if (message.role !== "assistant") return message;
    if (index > lastLoad && !resumed?.has(message)) return message;
    if (!message.content.some((block) => block.type === "thinking")) return message;
    changed = true;
    return { ...message, content: message.content.filter((block) => block.type !== "thinking") };
  });
  return changed ? out : messages;
}

/** Wrap a member's base StreamFn so its requests omit stale thinking blocks. */
export function withStaleThinkingDropped(base: StreamFn, stale: StaleThinkingOptions = {}): StreamFn {
  return (model, context, options) => {
    const messages = dropStaleThinking(context.messages, stale);
    return base(model, messages === context.messages ? context : { ...context, messages }, options);
  };
}
