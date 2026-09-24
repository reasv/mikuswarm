/**
 * Explicit prompt-cache breakpoint injection for the OpenAI Responses API.
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
 * Trigger item identification: the first user item whose text starts with
 * "<system>" or "<retrieved_memory>" is the per-session dynamic tail
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

    // Trigger item: first user item that begins with "<system>" or "<retrieved_memory>"
    let triggerIdx = -1;
    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      if (isInputRoleItem(item) && (item as Record<string, unknown>)["role"] === "user") {
        const text = getItemText(item);
        if (text.startsWith("<system>") || text.startsWith("<retrieved_memory>")) {
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
