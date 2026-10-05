/**
 * Judge-shaped state for checks (spec REFUSAL-HANDLING §5.5, DECISION-MODEL
 * §3.8). Pure functions: the sources a check judges, taken from the agent's
 * messages or a tool call's arguments, and the state object a decision call
 * receives, packed to a token budget.
 *
 * State fields:
 * - `request`: the trigger (chat), the kickoff (proactive) or the task
 *   instruction (internal jobs), as `[{ from, text }]`;
 * - `recent`: the last `[decisions.checks].recent_messages` chat messages;
 * - `action`: the judged tool name, `NO_REPLY`, `exhausted`, or the internal
 *   task's artifact kind;
 * - the sources: `message` (the model-written text being posted), `analysis`
 *   (the call's prefill `analysis` argument), `text` (the text block before the
 *   action), `thinking` (the tail of the thinking block), `artifact`,
 *   `rollout` (assistant-authored text of the last turns only, never the
 *   task's source material);
 * - endings after a nudge: `nudges` (the count) and `first_attempt` (the text
 *   written before the first nudge).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "../context/tokens.js";
import { clipText, packNewest } from "../decisions/state.js";
import type { CheckSource, Checkpoint } from "./types.js";

/** One chat message in check state. */
export interface StateMessage {
  from: string;
  text: string;
  self?: true;
  attachments?: string[];
}

/** The texts a check can judge (each is one `CheckSource`). */
export interface CheckSources {
  message?: string;
  analysis?: string;
  text?: string;
  thinking?: string;
  artifact?: string;
  /** Assistant-authored texts of the last turns, oldest first. */
  rollout?: string[];
}

/** What surrounds the judged output. */
export interface CheckContext {
  /** The checkpoint being judged (selects the judge shape's output sources). */
  checkpoint?: Checkpoint;
  request?: StateMessage[];
  recent?: StateMessage[];
  action: string;
  /** Forced-completion nudges since the last inbound message (endings). */
  nudges?: number;
  /** Text written before the first nudge (endings after a nudge). */
  firstAttempt?: string;
}

/** Per-field character clips (the token budget clips further when needed). */
export const STATE_CLIPS = {
  request: 1200,
  recent: 400,
  message: 4000,
  analysis: 2000,
  text: 2000,
  artifact: 4000,
  rolloutItem: 1500,
  firstAttempt: 2000,
} as const;

/** Assistant turns a rollout source keeps (assistant-authored text only). */
export const ROLLOUT_TURNS = 3;

const NO_REPLY_TEXT = "NO_REPLY";

/** The corrective prompts of forced completion, by their stable opening words. */
const NUDGE_PREFIXES = [
  "Your turn ended without sending a message.",
  "You already sent a message but your turn did not end cleanly.",
];

/** True when a source has something to judge. */
export function hasSource(sources: CheckSources, source: CheckSource): boolean {
  const value = sources[source];
  if (Array.isArray(value)) return value.some((t) => t.trim().length > 0);
  return typeof value === "string" && value.trim().length > 0;
}

/** The source as one string (a rollout joined by blank lines). */
export function sourceText(sources: CheckSources, source: CheckSource): string {
  const value = sources[source];
  if (Array.isArray(value)) return value.join("\n\n");
  return value ?? "";
}

/**
 * The model-written text a posting tool would put in the chat (spec §6.1):
 * the message body, an edit's new text, a poll's question and options.
 * Undefined when the call carries none (a media-only send, a `message_ref`
 * re-send of a stashed body).
 */
export function postedText(toolName: string, args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  switch (toolName) {
    case "send_message":
    case "send_dm":
    case "send_to_channel":
      return str(args["message"]);
    case "edit_message":
      return str(args["text"]);
    case "create_poll": {
      const question = str(args["question"]) ?? "";
      const options = Array.isArray(args["options"]) ? args["options"].filter((o) => typeof o === "string") : [];
      const text = [question, ...options.map((o) => `- ${o}`)].join("\n").trim();
      return text.length > 0 ? text : undefined;
    }
    default:
      return undefined;
  }
}

type Block = { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };

function blocksOf(message: unknown): Block[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

function roleOf(message: unknown): string | undefined {
  const role = (message as { role?: unknown } | undefined)?.role;
  return typeof role === "string" ? role : undefined;
}

function userText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  return blocksOf(message)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/** A forced-completion corrective turn (tagged by the runner, or by its known wording). */
export function isNudgeMessage(message: unknown): boolean {
  if (roleOf(message) !== "user") return false;
  const harness = (message as { harness?: { kind?: unknown } }).harness;
  if (harness?.kind === "forced_completion") return true;
  const text = userText(message).trimStart();
  return NUDGE_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** A user turn that brought new input (a trigger, an interjection), not a harness turn. */
export function isInboundMessage(message: unknown): boolean {
  if (roleOf(message) !== "user") return false;
  if ((message as { harness?: unknown }).harness !== undefined) return false;
  return !isNudgeMessage(message);
}

/** Assistant text blocks joined; the exact `NO_REPLY` marker counts as no text. */
export function assistantText(message: unknown): string {
  const text = blocksOf(message)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  return text === NO_REPLY_TEXT ? "" : text;
}

/** Assistant thinking blocks joined (redacted blocks carry no text). */
export function assistantThinking(message: unknown): string {
  return blocksOf(message)
    .filter((b) => b.type === "thinking")
    .map((b) => b.thinking ?? "")
    .join("\n")
    .trim();
}

/** Index of the assistant message holding the tool call `toolCallId`, or -1. */
export function findCallMessage(messages: readonly unknown[], toolCallId: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (roleOf(m) !== "assistant") continue;
    if (blocksOf(m).some((b) => b.type === "toolCall" && b.id === toolCallId)) return i;
  }
  return -1;
}

/** Index of the last inbound user message at or before `before`, or -1. */
function lastInboundIndex(messages: readonly unknown[], before: number): number {
  for (let i = Math.min(before, messages.length - 1); i >= 0; i--) {
    if (isInboundMessage(messages[i])) return i;
  }
  return -1;
}

/**
 * The `text` and `thinking` sources of an action (spec §5.4): from the
 * assistant message containing it, else from the previous assistant message
 * since the last inbound message (per source). `containing` may be a message
 * that is not in `messages` yet (the streaming partial at `toolcall_end`);
 * `searchBefore` is then `messages.length`.
 */
export function reasoningSources(
  messages: readonly unknown[],
  containing: unknown | undefined,
  searchBefore: number,
): { text?: string; thinking?: string } {
  const out: { text?: string; thinking?: string } = {};
  if (containing) {
    const text = assistantText(containing);
    const thinking = assistantThinking(containing);
    if (text) out.text = text;
    if (thinking) out.thinking = thinking;
  }
  if (out.text && out.thinking) return out;
  const floor = lastInboundIndex(messages, searchBefore - 1);
  for (let i = searchBefore - 1; i > floor; i--) {
    const m = messages[i];
    if (roleOf(m) !== "assistant") continue;
    if (!out.text) {
      const text = assistantText(m);
      if (text) out.text = text;
    }
    if (!out.thinking) {
      const thinking = assistantThinking(m);
      if (thinking) out.thinking = thinking;
    }
    if (out.text && out.thinking) break;
  }
  return out;
}

/**
 * Forced-completion nudges since the last inbound message, and the text the
 * model wrote before the first of them (spec §7.4).
 */
export function nudgeHistory(messages: readonly unknown[]): { nudges: number; firstAttempt?: string } {
  const floor = lastInboundIndex(messages, messages.length - 1);
  let nudges = 0;
  let firstNudge = -1;
  for (let i = floor + 1; i < messages.length; i++) {
    if (isNudgeMessage(messages[i])) {
      nudges += 1;
      if (firstNudge < 0) firstNudge = i;
    }
  }
  if (nudges === 0) return { nudges };
  const texts: string[] = [];
  for (let i = floor + 1; i < firstNudge; i++) {
    if (roleOf(messages[i]) !== "assistant") continue;
    const text = assistantText(messages[i]);
    if (text) texts.push(text);
  }
  return texts.length > 0 ? { nudges, firstAttempt: texts.join("\n\n") } : { nudges };
}

/**
 * The assistant-authored text of the last `turns` assistant messages (spec
 * §5.2: never the task's source material, which lives in user turns and tool
 * results).
 */
export function rolloutTexts(messages: readonly AgentMessage[] | readonly unknown[], turns = ROLLOUT_TURNS): string[] {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < turns; i--) {
    if (roleOf(messages[i]) !== "assistant") continue;
    const text = assistantText(messages[i]);
    if (text) out.unshift(clipText(text, STATE_CLIPS.rolloutItem));
  }
  return out;
}

/** The last `maxTokens` of a text (thinking tails: the decision is at the end). */
export function tailTokens(text: string, maxTokens: number): string {
  const flat = text.trim();
  if (estimateTokens(flat) <= maxTokens) return flat;
  let chars = Math.max(1, maxTokens * 4);
  let tail = flat.slice(-chars);
  while (chars > 1 && estimateTokens(tail) > maxTokens) {
    chars = Math.floor(chars * 0.8);
    tail = flat.slice(-chars);
  }
  return `…${tail.trimStart()}`;
}

/** Clip a text to `maxTokens` from its start (with an ellipsis). */
function headTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let chars = Math.max(1, maxTokens * 4);
  let head = clipText(text, chars);
  while (chars > 1 && estimateTokens(head) > maxTokens) {
    chars = Math.floor(chars * 0.8);
    head = clipText(text, chars);
  }
  return head;
}

/** Which state a call's questions read (spec §6.2 split by state shape). */
export type CheckStateScope = "full" | "message_only";

export interface CheckStateInput {
  context: CheckContext;
  sources: CheckSources;
  scope: CheckStateScope;
  thinkingTailTokens: number;
}

/**
 * The object-shaped check state (spec §5.5) for a token budget. Sources and the
 * request are kept (clipped further when the budget demands); `recent` is
 * packed newest-first into what remains.
 */
export function buildCheckState(input: CheckStateInput, budgetTokens: number): Record<string, unknown> {
  const { context, sources } = input;
  if (input.scope === "message_only") {
    const message = clipText(sources.message ?? "", STATE_CLIPS.message);
    return { message: headTokens(message, Math.max(16, budgetTokens - 8)) };
  }
  const fixed: Record<string, unknown> = {};
  const request = (context.request ?? []).map((m) => clipMessage(m, STATE_CLIPS.request));
  if (request.length > 0) fixed["request"] = request;
  fixed["action"] = context.action;
  if (context.nudges !== undefined && context.nudges > 0) fixed["nudges"] = context.nudges;
  if (context.firstAttempt) fixed["first_attempt"] = clipText(context.firstAttempt, STATE_CLIPS.firstAttempt);
  const texts: Array<[string, string]> = [];
  if (hasSource(sources, "message")) texts.push(["message", clipText(sources.message!, STATE_CLIPS.message)]);
  if (hasSource(sources, "analysis")) texts.push(["analysis", clipText(sources.analysis!, STATE_CLIPS.analysis)]);
  if (hasSource(sources, "text")) texts.push(["text", clipText(sources.text!, STATE_CLIPS.text)]);
  if (hasSource(sources, "thinking")) texts.push(["thinking", tailTokens(sources.thinking!, input.thinkingTailTokens)]);
  if (hasSource(sources, "artifact")) texts.push(["artifact", clipText(sources.artifact!, STATE_CLIPS.artifact)]);
  for (const [key, value] of texts) fixed[key] = value;
  if (hasSource(sources, "rollout")) {
    fixed["rollout"] = sources.rollout!.filter((t) => t.trim()).map((t) => clipText(t, STATE_CLIPS.rolloutItem));
  }

  // Over budget without any chat: shrink the long fields evenly.
  const fixedTokens = estimateTokens(JSON.stringify(fixed));
  if (fixedTokens > budgetTokens) {
    const share = Math.max(16, Math.floor((budgetTokens * 0.9) / Math.max(1, texts.length + 2)));
    for (const [key, value] of texts) {
      fixed[key] = key === "thinking" ? tailTokens(value, share) : headTokens(value, share);
    }
    if (Array.isArray(fixed["rollout"])) {
      fixed["rollout"] = (fixed["rollout"] as string[]).map((t) => headTokens(t, Math.max(8, Math.floor(share / 2))));
    }
    if (typeof fixed["first_attempt"] === "string") fixed["first_attempt"] = headTokens(fixed["first_attempt"], share);
    if (request.length > 0) fixed["request"] = request.map((m) => ({ ...m, text: headTokens(m.text, share) }));
  }

  const recent = (context.recent ?? []).map((m) => clipMessage(m, STATE_CLIPS.recent));
  if (recent.length === 0) return fixed;
  const build = (kept: StateMessage[]) => (kept.length > 0 ? { ...fixed, recent: kept } : fixed);
  return build(packNewest(recent, budgetTokens, build));
}

/**
 * The judge-shaped conversation (DECISION-MODEL §3.8) for members that accept
 * only `{ input, output }`: the request as input, the judged sources as the
 * output.
 */
export function buildJudgeState(
  context: CheckContext,
  output: string,
  budgetTokens: number,
): { input: Array<{ role: "user"; content: string }>; output: { role: "assistant"; content: string } } {
  const requestText = (context.request ?? []).map((m) => `${m.from}: ${m.text}`).join("\n");
  const half = Math.max(16, Math.floor(budgetTokens / 2) - 16);
  return {
    input: [{ role: "user", content: headTokens(clipText(requestText, STATE_CLIPS.request), half) }],
    output: { role: "assistant", content: headTokens(output, half) },
  };
}

function clipMessage(message: StateMessage, maxChars: number): StateMessage {
  return { ...message, text: clipText(message.text, maxChars) };
}
