/**
 * Explicit prompt-cache breakpoint injection for the OpenAI Responses API on
 * Amazon Bedrock, for the Anthropic Messages API (see the end of this header)
 * and for explicit-only Chat Completions caches (`injectChatCompletionsBreakpoints`
 * at the end of the file).
 *
 * Amazon Bedrock's prompt cache for OpenAI models (GPT-5.6, GPT-6) is
 * checkpoint-based: a breakpoint on a content block tells the provider "the
 * prefix up to and including this block is stable and should be cached."  The
 * default `implicit` mode places one automatic breakpoint on the latest
 * message; explicit breakpoints let up to 3 additional stable positions be
 * declared so the shared tools+instructions+summary prefix is reusable across
 * sessions in the same room (ARCHITECTURE.md §8 "Cache control").
 *
 * The injected field is `prompt_cache_breakpoint: { mode: "explicit" }` on
 * the last `input_text` content block of each chosen item.  For developer
 * items (whose `content` is a string) the string is converted to a one-block
 * array first.
 *
 * Three break positions (when each is present and above the 1024-token
 * cumulative minimum):
 *   (a) The leading developer/system item (agent instructions — always stable).
 *   (b) The conversation-summary user item (<conversation_summary …>).
 *   (c) The second-to-last user item before the trigger item, i.e. the last
 *       user batch that is reproduced verbatim across consecutive sessions,
 *       excluding the trailing batched user message that grows as new messages
 *       arrive.
 *
 * Trigger item identification: the first user item whose text opens a
 * `<system>` or `<retrieved_memory …>` tag is the per-session dynamic tail
 * (satellite block + optional auto-retrieval, see ARCHITECTURE.md §8).
 * NOTE: this heuristic identifies boundaries by wire-text prefix.  The context
 * builder (src/context/) is the authoritative source for these block kinds; a
 * follow-up should derive boundaries there and pass them through instead of
 * re-parsing the wire form.
 *
 * Gating: the injector is installed once per session via the pi-ai `onPayload`
 * hook, which receives the wire `model` descriptor as its second argument.
 * Injection is only performed when the serving member's descriptor carries
 * `compat.cacheBreakpoints === "explicit"` (set in `createModelFromConfig`
 * from the model config's `cache_breakpoints` option).  This ensures that
 * fallback members without the option — e.g. a direct-OpenAI model in the
 * same chain as a Bedrock head — never receive the Bedrock-specific field.
 * NOTE (cumulative-token bookkeeping): in the no-summary branch the items
 * between developer and lastStable are counted twice (once in the gap-fill
 * loop, once via lastStable's own token count) — this only affects the 1024
 * floor check and cannot produce false negatives at real session sizes.

 *
 * Anthropic Messages API (`api = "anthropic-messages"`, same option): Anthropic
 * caches block prefixes up to each `cache_control` marker, and a later request
 * reads the longest stored prefix ending at a block within about 20 blocks
 * before one of its own markers.  pi-ai marks the system prompt (which, with the
 * tools rendered ahead of it, is the agent-wide prefix) and the last user
 * message, so a new session in the same room re-writes the whole timeline.
 * {@link injectAnthropicBreakpoints} adds up to two markers, within Anthropic's
 * limit of four per request:
 *   (c) the last cache-markable block of the item just before the last user
 *       item preceding the trigger item: the timeline up to there is reproduced
 *       verbatim by the next session in the room, while that last user item may
 *       still grow (a message batched into it).
 *   (b) the conversation-summary user item (fallback when (c) has moved on).
 * The marker reuses pi-ai's own `cache_control` value from the request (so the
 * TTL matches); when pi-ai placed none (caching off) nothing is added.
 */

// Augment pi-ai's OpenAIResponsesCompat so createModelFromConfig can carry the
// Bedrock cache_breakpoints preference on the wire Model descriptor.  The
// injector reads it from the `model` arg of onPayload so the decision follows
// the serving fallback member, not the chain head.
declare module "@earendil-works/pi-ai" {
  interface OpenAIResponsesCompat {
    /**
     * When `"explicit"`, the onPayload injector places Bedrock
     * `prompt_cache_breakpoint` markers at the three stable prefix boundaries.
     * Only meaningful for models served via Amazon Bedrock's Responses API.
     */
    cacheBreakpoints?: "explicit";
  }
}

/**
 * Opening of the per-session tail: the satellite `<system>` block or the
 * auto-retrieval `<retrieved_memory note="…">` block, with or without attributes.
 */
const TRIGGER_OPEN = /^<(?:system|retrieved_memory)[\s>]/;

/** Explicit prompt-cache breakpoint marker, as required by Bedrock's Responses API. */
const PROMPT_CACHE_BREAKPOINT = { prompt_cache_breakpoint: { mode: "explicit" } } as const;

/**
 * Minimum cumulative tokens (text only, not including tools) for a breakpoint
 * position to qualify.  Bedrock requires >= 1024 tokens in the cumulative
 * prefix at each breakpoint; at real session sizes (tools ~6 k, developer
 * ~6 k) all three positions comfortably exceed this floor.
 */
const MIN_CUMULATIVE_TOKENS = 1024;

/** Extract concatenated text content from a wire input item. */
function getItemText(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const it = item as Record<string, unknown>;
  const content = it["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Record<string, unknown> => !!b && typeof b === "object" && b["type"] === "input_text")
    .map((b) => (typeof b["text"] === "string" ? b["text"] : ""))
    .join("");
}

/**
 * Return a shallow copy of `item` with `prompt_cache_breakpoint` added to its
 * last `input_text` content block.  If `content` is a string it is first
 * converted to a single `input_text` block array (required for developer items
 * whose content pi-ai serialises as a plain string).  Returns the item
 * unchanged if it has no `input_text` block.
 */
function addBreakpoint(item: Record<string, unknown>): Record<string, unknown> {
  const content = item["content"];
  if (typeof content === "string") {
    return {
      ...item,
      content: [{ type: "input_text", text: content, ...PROMPT_CACHE_BREAKPOINT }],
    };
  }
  if (Array.isArray(content)) {
    let lastIdx = -1;
    for (let i = content.length - 1; i >= 0; i--) {
      const b = content[i];
      if (b && typeof b === "object" && (b as Record<string, unknown>)["type"] === "input_text") {
        lastIdx = i;
        break;
      }
    }
    if (lastIdx === -1) return item;
    const newContent = [...content];
    newContent[lastIdx] = { ...(content[lastIdx] as object), ...PROMPT_CACHE_BREAKPOINT };
    return { ...item, content: newContent };
  }
  return item;
}

/**
 * Return `true` if the item has a `role` of `"user"`, `"developer"`, or
 * `"system"` — roles that carry `input_text` content blocks.
 */
function isInputRoleItem(item: unknown): item is Record<string, unknown> {
  if (!item || typeof item !== "object") return false;
  const role = (item as Record<string, unknown>)["role"];
  return role === "user" || role === "developer" || role === "system";
}

/**
 * Build an `onPayload` function for the openai-responses wire path that
 * injects explicit Bedrock prompt-cache breakpoints at the three stable prefix
 * boundaries.
 *
 * The injector gates on `model.compat.cacheBreakpoints === "explicit"` (the
 * second argument pi-ai passes to `onPayload`).  This means the decision is
 * made per serving fallback member: a Bedrock chain head with the option
 * enabled will inject, while a direct-OpenAI fallback member without it will
 * receive an identity passthrough — even though both share the same `onPayload`
 * closure installed at session creation time.
 *
 * @param estimateTokensFn - primary tokenizer's token counter (from
 *   `src/context/tokens.ts`).  Used for the 1024-token cumulative minimum
 *   check; counts text only (tools tokens are not included here but the
 *   combined prefix comfortably exceeds the floor at any real session size).
 */
export function makeBreakpointInjector(
  estimateTokensFn: (text: string) => number,
): (payload: unknown, model: unknown) => unknown {
  return (payload: unknown, model: unknown): unknown => {
    // Gate on the serving member's descriptor — only inject when cacheBreakpoints
    // is "explicit" on the model being called right now.
    const compat = (model as Record<string, unknown> | undefined)?.["compat"] as
      | Record<string, unknown>
      | undefined;
    if (compat?.["cacheBreakpoints"] !== "explicit") return payload;

    if (!payload || typeof payload !== "object") return payload;
    const p = payload as Record<string, unknown>;
    if ((model as Record<string, unknown>)["api"] === "anthropic-messages") return injectAnthropicBreakpoints(p);
    if ((model as Record<string, unknown>)["api"] === "openai-completions") {
      return injectChatCompletionsBreakpoints(p, estimateTokensFn);
    }
    if (!Array.isArray(p["input"]) || p["input"].length === 0) return payload;

    const input = p["input"] as unknown[];

    // ── locate the three breakpoint targets ──────────────────────────────────

    // (a) developer/system item — always the first item when present
    let developerIdx = -1;
    if (
      isInputRoleItem(input[0]) &&
      ((input[0] as Record<string, unknown>)["role"] === "developer" ||
        (input[0] as Record<string, unknown>)["role"] === "system")
    ) {
      developerIdx = 0;
    }

    // (b) conversation-summary user item
    let summaryIdx = -1;
    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      if (isInputRoleItem(item) && (item as Record<string, unknown>)["role"] === "user") {
        const text = getItemText(item);
        if (text.startsWith("<conversation_summary")) {
          summaryIdx = i;
          break;
        }
      }
    }

    // Trigger item: first user item that opens a <system> or <retrieved_memory> tag
    let triggerIdx = -1;
    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      if (isInputRoleItem(item) && (item as Record<string, unknown>)["role"] === "user") {
        const text = getItemText(item);
        if (TRIGGER_OPEN.test(text)) {
          triggerIdx = i;
          break;
        }
      }
    }

    // (c) second-to-last user item before the trigger (last stable timeline batch)
    //     Skip if it coincides with summaryIdx (already covered by (b)).
    let lastStableIdx = -1;
    if (triggerIdx > 0) {
      let userCount = 0;
      for (let i = triggerIdx - 1; i >= 0; i--) {
        const item = input[i];
        if (isInputRoleItem(item) && (item as Record<string, unknown>)["role"] === "user") {
          userCount++;
          if (userCount === 2) {
            const idx = i;
            // Don't duplicate the summary breakpoint
            if (idx !== summaryIdx) lastStableIdx = idx;
            break;
          }
        }
      }
    }

    // ── compute cumulative token count and inject ─────────────────────────────

    const newInput = [...input];
    let cumTokens = 0;

    // (a) developer/system item
    if (developerIdx >= 0) {
      const text = getItemText(newInput[developerIdx]);
      cumTokens += estimateTokensFn(text);
      if (cumTokens >= MIN_CUMULATIVE_TOKENS) {
        newInput[developerIdx] = addBreakpoint(newInput[developerIdx] as Record<string, unknown>);
      }
    }

    // Accumulate tokens for everything between developer and summary
    {
      const from = developerIdx >= 0 ? developerIdx + 1 : 0;
      const to = summaryIdx >= 0 ? summaryIdx : lastStableIdx >= 0 ? lastStableIdx : input.length;
      for (let i = from; i < to; i++) {
        cumTokens += estimateTokensFn(getItemText(newInput[i]));
      }
    }

    // (b) summary item
    if (summaryIdx >= 0) {
      cumTokens += estimateTokensFn(getItemText(newInput[summaryIdx]));
      if (cumTokens >= MIN_CUMULATIVE_TOKENS) {
        newInput[summaryIdx] = addBreakpoint(newInput[summaryIdx] as Record<string, unknown>);
      }
    }

    // Accumulate tokens for everything between summary and last stable item
    if (lastStableIdx >= 0) {
      const from = summaryIdx >= 0 ? summaryIdx + 1 : developerIdx >= 0 ? developerIdx + 1 : 0;
      for (let i = from; i < lastStableIdx; i++) {
        cumTokens += estimateTokensFn(getItemText(newInput[i]));
      }
      // (c) last stable timeline user item
      cumTokens += estimateTokensFn(getItemText(newInput[lastStableIdx]));
      if (cumTokens >= MIN_CUMULATIVE_TOKENS) {
        newInput[lastStableIdx] = addBreakpoint(newInput[lastStableIdx] as Record<string, unknown>);
      }
    }

    return { ...p, input: newInput };
  };
}

// ── Anthropic Messages API ──────────────────────────────────────────────────

/** Anthropic's per-request limit on `cache_control` markers. */
const ANTHROPIC_MAX_BREAKPOINTS = 4;

/** Content block types that may carry `cache_control` (thinking blocks may not). */
const ANTHROPIC_MARKABLE_BLOCKS = new Set(["text", "image", "document", "tool_use", "tool_result"]);

/** Text of an Anthropic message's first text block (or its string content). */
function anthropicLeadingText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const first = content.find((b) => !!b && typeof b === "object" && (b as Record<string, unknown>)["type"] === "text");
  const text = (first as Record<string, unknown> | undefined)?.["text"];
  return typeof text === "string" ? text : "";
}

function isAnthropicUser(message: unknown): boolean {
  return !!message && typeof message === "object" && (message as Record<string, unknown>)["role"] === "user";
}

/** Blocks carrying `cache_control` in a block array (non-arrays count zero). */
function markedBlocks(blocks: unknown): Record<string, unknown>[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter(
    (b): b is Record<string, unknown> =>
      !!b && typeof b === "object" && (b as Record<string, unknown>)["cache_control"] !== undefined,
  );
}

/**
 * Return a copy of `message` with `cacheControl` on its last markable block, or
 * `undefined` when it has none (or that block is already marked). String
 * content becomes a one-block text array.
 */
function markAnthropicMessage(message: unknown, cacheControl: unknown): Record<string, unknown> | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as Record<string, unknown>;
  const content = m["content"];
  if (typeof content === "string") {
    if (content.length === 0) return undefined;
    return { ...m, content: [{ type: "text", text: content, cache_control: cacheControl }] };
  }
  if (!Array.isArray(content)) return undefined;
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as Record<string, unknown> | null;
    if (!block || typeof block !== "object") continue;
    const type = block["type"];
    if (typeof type !== "string" || !ANTHROPIC_MARKABLE_BLOCKS.has(type)) continue;
    if (type === "text" && (typeof block["text"] !== "string" || block["text"].length === 0)) continue;
    if (block["cache_control"] !== undefined) return undefined;
    const next = [...content];
    next[i] = { ...block, cache_control: cacheControl };
    return { ...m, content: next };
  }
  return undefined;
}

/**
 * Add the timeline (c) and summary (b) `cache_control` markers to an
 * anthropic-messages payload (see the module header). Pure: returns a new
 * payload, or the input unchanged when nothing qualifies.
 */
export function injectAnthropicBreakpoints(p: Record<string, unknown>): Record<string, unknown> {
  const messages = p["messages"];
  if (!Array.isArray(messages) || messages.length === 0) return p;

  const existing = [
    ...markedBlocks(p["system"]),
    ...markedBlocks(p["tools"]),
    ...messages.flatMap((m) => markedBlocks((m as Record<string, unknown> | null)?.["content"])),
  ];
  let slots = ANTHROPIC_MAX_BREAKPOINTS - existing.length;
  if (slots <= 0) return p;
  // Follow pi-ai's marker (its TTL); none means caching is off for this request.
  const cacheControl = existing[0]?.["cache_control"];
  if (cacheControl === undefined) return p;

  let summaryIdx = -1;
  let triggerIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (!isAnthropicUser(messages[i])) continue;
    const text = anthropicLeadingText(messages[i]);
    if (summaryIdx < 0 && text.startsWith("<conversation_summary")) summaryIdx = i;
    if (TRIGGER_OPEN.test(text)) {
      triggerIdx = i;
      break;
    }
  }

  let stableIdx = -1;
  if (triggerIdx > 0) {
    let lastUser = -1;
    for (let i = triggerIdx - 1; i >= 0; i--) {
      if (isAnthropicUser(messages[i])) {
        lastUser = i;
        break;
      }
    }
    if (lastUser - 1 > summaryIdx) stableIdx = lastUser - 1;
  }

  const out = [...messages];
  let changed = false;
  for (const idx of [stableIdx, summaryIdx]) {
    if (idx < 0 || slots <= 0) continue;
    const marked = markAnthropicMessage(out[idx], cacheControl);
    if (!marked) continue;
    out[idx] = marked;
    slots--;
    changed = true;
  }
  return changed ? { ...p, messages: out } : p;
}

// ── Chat Completions API ────────────────────────────────────────────────────

/** Text of a Chat Completions message: string content or its `text` parts. */
function chatMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Record<string, unknown> => !!b && typeof b === "object" && b["type"] === "text")
    .map((b) => (typeof b["text"] === "string" ? b["text"] : ""))
    .join("");
}

function chatRole(message: unknown): unknown {
  return message && typeof message === "object" ? (message as Record<string, unknown>)["role"] : undefined;
}

/**
 * Return a copy of `message` with `prompt_cache_breakpoint` on its last `text`
 * part, or `undefined` when it has none (an assistant turn that only calls
 * tools, an image-only part list). Non-empty string content becomes a
 * one-part text array.
 */
function markChatMessage(message: unknown): Record<string, unknown> | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as Record<string, unknown>;
  const content = m["content"];
  if (typeof content === "string") {
    if (content.length === 0) return undefined;
    return { ...m, content: [{ type: "text", text: content, ...PROMPT_CACHE_BREAKPOINT }] };
  }
  if (!Array.isArray(content)) return undefined;
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i] as Record<string, unknown> | null;
    if (!part || typeof part !== "object" || part["type"] !== "text") continue;
    if (typeof part["text"] !== "string" || part["text"].length === 0) continue;
    const next = [...content];
    next[i] = { ...part, ...PROMPT_CACHE_BREAKPOINT };
    return { ...m, content: next };
  }
  return undefined;
}

/**
 * Add Bedrock `prompt_cache_breakpoint` markers to an openai-completions
 * payload, for providers whose Chat Completions cache is explicit-only (Kimi
 * K3 on Amazon Bedrock: no automatic breakpoint, and a request reads a cached
 * prefix only at a breakpoint position it repeats exactly). Marked messages:
 *   (a) the leading system/developer message,
 *   (b) the conversation-summary user message,
 *   (c) the last stable timeline user message before the trigger (the same
 *       choice as the Responses path),
 *   (d) the last message: the whole request is written to the cache,
 *   (e) the message just before the last assistant message, which was (d) of
 *       the previous request in this session; repeating it is what lets an
 *       agent-loop request read the prefix its predecessor wrote.
 * (a)–(c) need >= 1024 cumulative estimated tokens, (d) and (e) a whole request
 * of that size. Pure: returns a new payload, or the input when nothing qualifies.
 */
export function injectChatCompletionsBreakpoints(
  p: Record<string, unknown>,
  estimateTokensFn: (text: string) => number,
): Record<string, unknown> {
  const messages = p["messages"];
  if (!Array.isArray(messages) || messages.length === 0) return p;

  const role0 = chatRole(messages[0]);
  const developerIdx = role0 === "system" || role0 === "developer" ? 0 : -1;
  let summaryIdx = -1;
  let triggerIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (chatRole(messages[i]) !== "user") continue;
    const text = chatMessageText(messages[i]);
    if (summaryIdx < 0 && text.startsWith("<conversation_summary")) summaryIdx = i;
    if (TRIGGER_OPEN.test(text)) {
      triggerIdx = i;
      break;
    }
  }
  let stableIdx = -1;
  if (triggerIdx > 0) {
    let userCount = 0;
    for (let i = triggerIdx - 1; i >= 0; i--) {
      if (chatRole(messages[i]) !== "user") continue;
      if (++userCount === 2) {
        if (i !== summaryIdx) stableIdx = i;
        break;
      }
    }
  }

  const cumulative: number[] = [];
  let running = 0;
  for (const message of messages) {
    running += estimateTokensFn(chatMessageText(message));
    cumulative.push(running);
  }
  const targets = new Set<number>();
  for (const idx of [developerIdx, summaryIdx, stableIdx]) {
    if (idx >= 0 && cumulative[idx]! >= MIN_CUMULATIVE_TOKENS) targets.add(idx);
  }
  if (running >= MIN_CUMULATIVE_TOKENS) {
    targets.add(messages.length - 1);
    for (let i = messages.length - 1; i > 0; i--) {
      if (chatRole(messages[i]) === "assistant") {
        if (chatRole(messages[i - 1]) !== "assistant") targets.add(i - 1);
        break;
      }
    }
  }

  const out = [...messages];
  let changed = false;
  for (const idx of targets) {
    const marked = markChatMessage(out[idx]);
    if (!marked) continue;
    out[idx] = marked;
    changed = true;
  }
  return changed ? { ...p, messages: out } : p;
}
