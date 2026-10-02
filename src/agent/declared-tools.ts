/**
 * Declared-deferred tool loading for the Anthropic Messages API (config
 * `[models.<name>.compat] declare_deferred_tools`, ARCHITECTURE.md §10 Transport).
 *
 * The Messages API's own prefix-stable load point is a `tool_reference` block.
 * Where an endpoint or an intermediary rejects that block, the only fallback
 * used to be growing `tools`, which is not an append: `tools` leads the request,
 * so every load re-writes the cached prefix and invalidates anything bound to
 * it. This transport keeps a load append-only without the block:
 *
 * - `tools` is the session's WHOLE catalog on every request, in catalog order.
 *   The immediate tools are ordinary definitions; every other tool carries
 *   `defer_loading: true`, so it is declared (callable) but its definition is
 *   not loaded into the model's context. The array never changes.
 * - A load event is delivered as text: the loading tool's result gets one extra
 *   text block with the definitions of the tools it added. The block is derived
 *   from the transcript's `addedToolNames`, so it is identical on every replay.
 *
 * The agent's own tool table is untouched: a call to a tool that was never
 * loaded still gets pi-agent-core's "tool not found" result.
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Context, Message, Tool } from "@earendil-works/pi-ai";

// Augment pi-ai's AnthropicMessagesCompat so createModelFromConfig can carry the
// option on the wire Model descriptor. The onPayload injector reads it from the
// `model` arg to gate per serving member, not per chain head.
declare module "@earendil-works/pi-ai" {
  interface AnthropicMessagesCompat {
    /** When true, the member uses the declared-deferred tool-loading transport. */
    declareDeferredTools?: boolean;
  }
}

/** A session's catalog and the names that are loaded from the first request on. */
export interface DeclaredToolSet {
  catalog: readonly Tool[];
  immediate: ReadonlySet<string>;
}

/** The text that stands in for a `tool_reference` load point. */
export function renderLoadedToolDefinitions(tools: readonly Tool[]): string {
  const blocks = tools.map(
    (tool) => `${tool.name}\n${tool.description}\nInput schema (JSON Schema): ${JSON.stringify(tool.parameters)}`,
  );
  return `Tool definitions now loaded. Call these like any other tool, with arguments that match the schema.\n\n${blocks.join("\n\n")}`;
}

function addedToolNames(message: Message): string[] {
  if (message.role !== "toolResult") return [];
  const added = (message as { addedToolNames?: unknown }).addedToolNames;
  return Array.isArray(added) ? added.filter((name): name is string => typeof name === "string") : [];
}

/**
 * Rewrite one request context for the declared-deferred transport: the full
 * catalog as `tools`, and the loaded definitions appended to each load point.
 */
export function declareDeferredTools(context: Context, set: DeclaredToolSet): Context {
  const byName = new Map(set.catalog.map((tool) => [tool.name, tool]));
  const messages = context.messages.map((message) => {
    const loaded = addedToolNames(message)
      .filter((name) => !set.immediate.has(name))
      .map((name) => byName.get(name))
      .filter((tool): tool is Tool => tool !== undefined);
    if (loaded.length === 0 || message.role !== "toolResult") return message;
    return {
      ...message,
      content: [...message.content, { type: "text" as const, text: renderLoadedToolDefinitions(loaded) }],
    };
  });
  return { ...context, tools: [...set.catalog], messages };
}

/**
 * Wrap a member's base StreamFn so its requests use the declared-deferred
 * transport. `getSet` is late-bound (the registry is built after the model
 * chain) and returns undefined for a session without dynamic tool loading,
 * which leaves the request untouched.
 */
export function withDeclaredDeferredTools(base: StreamFn, getSet: () => DeclaredToolSet | undefined): StreamFn {
  return (model, context, options) => {
    const set = getSet();
    return base(model, set ? declareDeferredTools(context, set) : context, options);
  };
}

/**
 * The `onPayload` half: mark every non-immediate tool `defer_loading` on the
 * wire. Gated per serving member on `compat.declareDeferredTools`, so other
 * members of the same chain pass their payloads through unchanged.
 */
export function makeDeferLoadingInjector(
  getImmediate: () => ReadonlySet<string> | undefined,
): (payload: unknown, model: unknown) => unknown {
  return (payload: unknown, model: unknown): unknown => {
    const compat = (model as Record<string, unknown> | undefined)?.["compat"] as Record<string, unknown> | undefined;
    if (compat?.["declareDeferredTools"] !== true) return payload;
    const immediate = getImmediate();
    if (!immediate || !payload || typeof payload !== "object") return payload;
    const tools = (payload as Record<string, unknown>)["tools"];
    if (!Array.isArray(tools)) return payload;
    return {
      ...(payload as Record<string, unknown>),
      tools: tools.map((tool) => {
        const name = (tool as { name?: unknown } | null)?.name;
        return typeof name === "string" && !immediate.has(name) ? { ...(tool as object), defer_loading: true } : tool;
      }),
    };
  };
}
