/**
 * Declared-deferred tool loading for the Anthropic Messages API (config
 * `[models.<name>.compat] declare_deferred_tools`, ARCHITECTURE.md §10 Transport).
 *
 * On the Messages API a tool that is added mid-conversation is meant to be
 * declared in `tools` from the start with `defer_loading: true` and surfaced
 * later by a `tool_reference` block. Declaring it only at load time changes
 * `tools`, which leads the request: the cached prefix is re-written, and a model
 * that binds its thinking blocks to the request prefix rejects the earlier ones.
 * This transport keeps `tools` fixed for the whole session:
 *
 * - `tools` is the session's WHOLE catalog on every request, in catalog order.
 *   The immediate tools are ordinary definitions; every other tool carries
 *   `defer_loading: true`, so it is declared (callable) but its definition is
 *   not loaded into the model's context.
 * - A load point is the loading tool's result. With tool references on, pi-ai
 *   puts a `tool_reference` block there. With them off (an endpoint or an
 *   intermediary that rejects the block), the result gets one extra text block
 *   with the added definitions instead. Either way the load point is derived
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

export interface DeclaredToolOptions {
  /**
   * Whether the member's driver emits `tool_reference` blocks at load points
   * (the descriptor's `supportsToolReferences`). When false, every load is
   * delivered as text.
   */
  references: boolean;
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
 * catalog as `tools`, and a text load point wherever no `tool_reference` will
 * be emitted. With references on that is only a tool the model already called
 * before loading it: pi-ai's `splitDeferredTools` treats such a tool as already
 * in use and emits no reference for it.
 */
export function declareDeferredTools(context: Context, set: DeclaredToolSet, options: DeclaredToolOptions): Context {
  const byName = new Map(set.catalog.map((tool) => [tool.name, tool]));
  const called = new Set<string>();
  const messages = context.messages.map((message) => {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") called.add(block.name);
      return message;
    }
    if (message.role !== "toolResult") return message;
    const asText = addedToolNames(message)
      .filter((name) => !set.immediate.has(name) && (!options.references || called.has(name)))
      .map((name) => byName.get(name))
      .filter((tool): tool is Tool => tool !== undefined);
    if (asText.length === 0) return message;
    return {
      ...message,
      content: [...message.content, { type: "text" as const, text: renderLoadedToolDefinitions(asText) }],
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
export function withDeclaredDeferredTools(
  base: StreamFn,
  getSet: () => DeclaredToolSet | undefined,
  options: DeclaredToolOptions,
): StreamFn {
  return (model, context, streamOptions) => {
    const set = getSet();
    return base(model, set ? declareDeferredTools(context, set, options) : context, streamOptions);
  };
}

/**
 * The `onPayload` half: put the wire `tools` in catalog order and mark every
 * non-immediate tool `defer_loading`, so the array is byte-identical on every
 * request whatever has been loaded (pi-ai moves referenced tools to the end).
 * A `cache_control` marker pi-ai placed on a tool is kept on the last
 * non-deferred one. Gated per serving member on `compat.declareDeferredTools`,
 * so other members of the same chain pass their payloads through unchanged.
 */
export function makeDeferLoadingInjector(
  getSet: () => DeclaredToolSet | undefined,
): (payload: unknown, model: unknown) => unknown {
  return (payload: unknown, model: unknown): unknown => {
    const compat = (model as Record<string, unknown> | undefined)?.["compat"] as Record<string, unknown> | undefined;
    if (compat?.["declareDeferredTools"] !== true) return payload;
    const set = getSet();
    if (!set || !payload || typeof payload !== "object") return payload;
    const tools = (payload as Record<string, unknown>)["tools"];
    if (!Array.isArray(tools)) return payload;

    const order = new Map(set.catalog.map((tool, index) => [tool.name, index]));
    const nameOf = (tool: unknown) => (tool as { name?: unknown } | null)?.name;
    const rank = (tool: unknown) => {
      const name = nameOf(tool);
      return typeof name === "string" ? (order.get(name) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    };
    let cacheControl: unknown;
    const out = tools
      .map((tool, index) => ({ tool, index }))
      .sort((a, b) => rank(a.tool) - rank(b.tool) || a.index - b.index)
      .map(({ tool }) => {
        if (!tool || typeof tool !== "object") return tool;
        const { cache_control, defer_loading: _deferLoading, ...rest } = tool as Record<string, unknown>;
        if (cache_control !== undefined) cacheControl = cache_control;
        const name = nameOf(tool);
        return typeof name === "string" && !set.immediate.has(name) ? { ...rest, defer_loading: true } : rest;
      });
    if (cacheControl !== undefined) {
      for (let i = out.length - 1; i >= 0; i--) {
        const tool = out[i] as Record<string, unknown> | null;
        if (tool && typeof tool === "object" && tool["defer_loading"] !== true) {
          out[i] = { ...tool, cache_control: cacheControl };
          break;
        }
      }
    }
    return { ...(payload as Record<string, unknown>), tools: out };
  };
}
