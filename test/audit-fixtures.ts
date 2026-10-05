/**
 * Synthetic transcript builders for the offline audit tests (spec
 * REFUSAL-HANDLING §7.6, §10.2, §15.1). No real chat content: every text is
 * invented for the test.
 */
import { FORCED_COMPLETION_PROMPTS } from "../src/agent/contract.js";

let clock = 1_000;
export const tick = () => clock++;
export function resetClock(at = 1_000): void {
  clock = at;
}

export const kick = (text = "please help with the thing") => ({ type: "triggerGroup", content: text, timestamp: tick() });
export const text = (t: string) => ({ type: "text", text: t });
export const thinking = (t: string) => ({ type: "thinking", thinking: t });
export const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: "toolCall", id, name, arguments: args });
export const asst = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: blocks,
  stopReason: "stop",
  model: "wire-a",
  timestamp: tick(),
  ...extra,
});
export const result = (id: string, name: string, isError = false) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text: isError ? "error" : "ok" }],
  isError,
  timestamp: tick(),
});
export const nudge = (attempt: number, variant: "not_sent" | "sent_not_final" = "not_sent") => ({
  role: "user",
  content: FORCED_COMPLETION_PROMPTS.current[variant],
  harness: { kind: "forced_completion", attempt, variant },
  timestamp: tick(),
});
/** A delivered send: the call and its successful result. */
export const sent = (id: string, message: string, extra: Record<string, unknown> = {}) => [
  asst([call(id, "send_message", { message, final: true, ...extra })], { stopReason: "toolUse" }),
  result(id, "send_message"),
];
export const noReply = (id: string, args: Record<string, unknown> = {}) => [
  asst([call(id, "no_reply", args)], { stopReason: "toolUse" }),
  result(id, "no_reply"),
];
