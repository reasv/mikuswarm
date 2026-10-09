import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { synthesizeErrorEvent } from "./request-retry.js";

/**
 * Report a Chat Completions turn whose tool call was cut off at the output cap
 * as a `length` stop. Some Chat Completions servers answer `finish_reason:
 * "tool_calls"` for a call truncated at `max_tokens`; pi-ai's best-effort JSON
 * salvage then hands the agent loop arguments that are silently incomplete, and
 * the loop executes them (or echoes them back whole in a validation error). On
 * a `length` stop the loop fails every call with a short "re-issue it" result
 * instead. A turn is treated as truncated when it stopped on tool calls and its
 * billed output reached the request's cap (`max_tokens` covers reasoning and the
 * answer together on this API). Other APIs report their max-token stops
 * reliably and pass through untouched.
 */
export function withTruncatedToolCallsAsLength(
  base: StreamFn,
  onTruncated?: (info: { model: string; outputTokens: number; maxTokens: number }) => void,
): StreamFn {
  return (model, context, options) => {
    const cap = options?.maxTokens ?? model.maxTokens;
    if (model.api !== "openai-completions" || !(cap > 0)) return base(model, context, options);
    const outer = createAssistantMessageEventStream();
    void (async () => {
      try {
        const inner = await base(model, context, options);
        for await (const event of inner) {
          const output = event.type === "done" ? event.message.usage?.output ?? 0 : 0;
          if (event.type === "done" && event.reason === "toolUse" && output >= cap) {
            const message: AssistantMessage = { ...event.message, stopReason: "length" };
            try {
              onTruncated?.({ model: model.id, outputTokens: output, maxTokens: cap });
            } catch {
              /* observe-only */
            }
            outer.push({ ...event, reason: "length", message });
          } else {
            outer.push(event);
          }
        }
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        outer.push(synthesizeErrorEvent(model, err instanceof Error ? err.message : String(err), aborted ? "aborted" : "error"));
      }
    })();
    return outer;
  };
}
