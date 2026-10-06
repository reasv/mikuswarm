/**
 * What the offline audit reads from a persisted transcript (spec
 * REFUSAL-HANDLING §5.4, §7.2–§7.3, §10.2). Pure functions over parsed
 * `transcript_json` (and the session's discarded branches):
 *
 * - {@link checkItems}: the outputs the check pass judges, anchored exactly as
 *   the live gate anchors them: every delivered posting call (checkpoint
 *   `send`, by tool call id) and every ending without a send (checkpoint
 *   `ending`: a `no_reply` call by tool call id, a `NO_REPLY` text ending or a
 *   forced-completion exhaustion by attempt number = nudges since the last
 *   inbound message).
 * - {@link contractRuns}: the nudged runs of the send-contract diagnosis: the
 *   message the model first tried to deliver, what it sent after the nudges,
 *   and how the run ended.
 */
import {
  chronology,
  isRunStart,
  looksLikeTextualToolCall,
  nudgeOf,
  servedModelOf,
  type ContractBranchInput,
} from "../agent/contract.js";
import { assistantText, postedText, reasoningSources, type CheckSources } from "../checks/state.js";
import type { Checkpoint } from "../checks/types.js";
import { isPostingTool } from "../tools/side-effects.js";

type Loose = Record<string, unknown>;
interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown> | undefined;
}

function asObj(m: unknown): Loose | undefined {
  return m !== null && typeof m === "object" ? (m as Loose) : undefined;
}

function isHarness(m: Loose): boolean {
  return m["harness"] !== undefined;
}

function toolCallsOf(m: unknown): ToolCall[] {
  const content = asObj(m)?.["content"];
  if (!Array.isArray(content)) return [];
  const out: ToolCall[] = [];
  for (const b of content as Loose[]) {
    if (!b || b["type"] !== "toolCall" || typeof b["name"] !== "string") continue;
    const args = asObj(b["arguments"]);
    out.push({ id: typeof b["id"] === "string" ? (b["id"] as string) : "", name: b["name"] as string, args });
  }
  return out;
}

/** Raw text blocks of an assistant message (the `NO_REPLY` marker included). */
function rawText(m: unknown): string {
  const content = asObj(m)?.["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Loose[])
    .filter((b) => b?.["type"] === "text" && typeof b["text"] === "string")
    .map((b) => b["text"] as string)
    .join("")
    .trim();
}

function isAssistantEnding(m: unknown): m is Loose {
  const o = asObj(m);
  return o?.["role"] === "assistant" && !isHarness(o);
}

function isIncomplete(m: Loose): boolean {
  return m["stopReason"] === "aborted" || m["stopReason"] === "error";
}

/** Parse `transcript_json`; undefined when absent or unreadable. */
export function parseTranscript(json: string | null | undefined): unknown[] | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Error flags of the tool results in `messages`, by tool call id. */
function resultErrors(messages: readonly unknown[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const m of messages) {
    const o = asObj(m);
    if (o?.["role"] === "toolResult" && typeof o["toolCallId"] === "string") {
      out.set(o["toolCallId"] as string, o["isError"] === true);
    }
  }
  return out;
}

/** A user turn that brought new input (a run start or an interjection), not a nudge or harness turn. */
function isInbound(m: unknown): boolean {
  return isRunStart(m);
}

/** Nudges between the last inbound message before `index` and `index`, and the text before the first. */
function nudgesBefore(messages: readonly unknown[], index: number): { nudges: number; firstAttempt?: string } {
  let floor = -1;
  for (let i = index - 1; i >= 0; i--) {
    if (isInbound(messages[i])) {
      floor = i;
      break;
    }
  }
  let nudges = 0;
  let firstNudge = -1;
  for (let i = floor + 1; i < index; i++) {
    if (nudgeOf(messages[i])) {
      nudges += 1;
      if (firstNudge < 0) firstNudge = i;
    }
  }
  if (nudges === 0) return { nudges };
  const texts: string[] = [];
  for (let i = floor + 1; i < firstNudge; i++) {
    if (!isAssistantEnding(messages[i])) continue;
    const text = assistantText(messages[i]);
    if (text) texts.push(text);
  }
  return texts.length > 0 ? { nudges, firstAttempt: texts.join("\n\n") } : { nudges };
}

/** One output the check pass judges (anchored like the live gate's evaluation). */
export interface AuditCheckItem {
  checkpoint: Extract<Checkpoint, "send" | "ending">;
  /** Tool name, `NO_REPLY` or `exhausted`. */
  action: string;
  toolCallId?: string;
  attemptNo?: number;
  sources: CheckSources;
  nudges?: number;
  firstAttempt?: string;
  servedModel?: string;
  wireModel?: string;
  ts?: number;
}

/**
 * The outputs of the live transcript (branch 0) the check pass judges. Messages
 * the harness wrote (tagged assistant turns) are never judged; a posting call is
 * judged only when it was delivered (a non-error result).
 */
export function checkItems(messages: readonly unknown[]): AuditCheckItem[] {
  const errors = resultErrors(messages);
  const items: AuditCheckItem[] = [];
  const meta = (m: Loose): Pick<AuditCheckItem, "servedModel" | "wireModel" | "ts"> => ({
    ...(servedModelOf(m) ? { servedModel: servedModelOf(m)! } : {}),
    ...(typeof m["model"] === "string" ? { wireModel: m["model"] as string } : {}),
    ...(typeof m["timestamp"] === "number" ? { ts: m["timestamp"] as number } : {}),
  });

  // Run boundaries: the last ending of each run is checked for NO_REPLY / exhaustion.
  const runEnds = new Set<number>();
  let lastEnding = -1;
  const closeRun = () => {
    if (lastEnding >= 0) runEnds.add(lastEnding);
    lastEnding = -1;
  };
  let inRecordTurn = false;
  for (let i = 0; i < messages.length; i++) {
    const m = asObj(messages[i]);
    if (!m) continue;
    if (m["role"] === "user" && asObj(m["harness"])?.["kind"] === "record_turn") {
      closeRun();
      inRecordTurn = true;
      continue;
    }
    if (isRunStart(m)) {
      closeRun();
      inRecordTurn = false;
      continue;
    }
    if (!inRecordTurn && isAssistantEnding(m)) lastEnding = i;
  }
  closeRun();

  inRecordTurn = false;
  for (let i = 0; i < messages.length; i++) {
    const m = asObj(messages[i]);
    if (!m) continue;
    if (m["role"] === "user" && asObj(m["harness"])?.["kind"] === "record_turn") {
      inRecordTurn = true;
      continue;
    }
    if (isRunStart(m)) inRecordTurn = false;
    if (inRecordTurn || !isAssistantEnding(m)) continue;
    const calls = toolCallsOf(m);
    const reasoning = reasoningSources(messages, m, i);
    for (const call of calls) {
      const analysis = typeof call.args?.["analysis"] === "string" ? (call.args["analysis"] as string) : undefined;
      if (isPostingTool(call.name)) {
        if (errors.get(call.id) !== false) continue; // not delivered (error, or no result)
        const sources: CheckSources = {};
        const message = postedText(call.name, call.args);
        if (message?.trim()) sources.message = message;
        if (analysis?.trim()) sources.analysis = analysis;
        if (reasoning.text) sources.text = reasoning.text;
        items.push({ checkpoint: "send", action: call.name, toolCallId: call.id, sources, ...meta(m) });
      } else if (call.name === "no_reply") {
        const sources: CheckSources = {};
        if (analysis?.trim()) sources.analysis = analysis;
        if (reasoning.text) sources.text = reasoning.text;
        if (reasoning.thinking) sources.thinking = reasoning.thinking;
        const history = nudgesBefore(messages, i);
        items.push({
          checkpoint: "ending",
          action: "no_reply",
          toolCallId: call.id,
          attemptNo: history.nudges,
          nudges: history.nudges,
          ...(history.firstAttempt ? { firstAttempt: history.firstAttempt } : {}),
          sources,
          ...meta(m),
        });
      }
    }
    if (!runEnds.has(i) || isIncomplete(m) || calls.length > 0 || m["stopReason"] === "toolUse") continue;
    // A run's last ending without a send: the NO_REPLY text, or exhaustion.
    const terminal = calls.some((c) => c.name === "send_message" || c.name === "no_reply");
    if (terminal) continue;
    const kind = rawText(m) === "NO_REPLY" ? "NO_REPLY" : "exhausted";
    const sources: CheckSources = {};
    if (reasoning.text) sources.text = reasoning.text;
    if (reasoning.thinking) sources.thinking = reasoning.thinking;
    const history = nudgesBefore(messages, i);
    items.push({
      checkpoint: "ending",
      action: kind,
      attemptNo: history.nudges,
      nudges: history.nudges,
      ...(history.firstAttempt ? { firstAttempt: history.firstAttempt } : {}),
      sources,
      ...meta(m),
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Send-contract runs (§7.3)
// ---------------------------------------------------------------------------

/** How a nudged run ended. */
export type ContractRunResult = "sent" | "switched_to_no_reply" | "nothing";

/** One nudged run (a failure point) of a session. */
export interface ContractRun {
  /** Ordinal of the run in the session (0-based, every run counted). */
  run: number;
  nudges: number;
  /**
   * The message the model first tried to deliver: the argument text of a
   * textual tool call, the text of a failed native send, else the first failed
   * ending's text. Empty when it wrote nothing.
   */
  firstAttempt: string;
  /** Where `firstAttempt` came from. */
  firstAttemptSource: "textual_tool_call" | "invalid_tool_call" | "text" | "none";
  /** The first failed ending's time and attribution. */
  ts: number | null;
  servedModel: string | null;
  wireModel: string | null;
  /** Texts delivered by posting calls after the first nudge, in order. */
  sent: string[];
  result: ContractRunResult;
  /** Every model-written ending of the run with a timestamp (matches `contract_attempts.ts`). */
  endings: Array<{ ts: number; text: string }>;
}

/**
 * Extract the message argument of a tool call written as text (best effort):
 * a JSON `"message"`/`"text"` string, or a `message=` / `text=` argument.
 * Undefined when none is found.
 */
export function textualCallMessage(text: string): string | undefined {
  const json = /"(?:message|text|content)"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
  if (json) {
    try {
      const value = JSON.parse(json[1]!) as unknown;
      if (typeof value === "string" && value.trim()) return value;
    } catch {
      /* fall through */
    }
  }
  const kw = /\b(?:message|text)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/.exec(text);
  const value = kw?.[1] ?? kw?.[2];
  return value && value.trim() ? value.replace(/\\n/g, "\n").replace(/\\(["'\\])/g, "$1") : undefined;
}

/**
 * The nudged runs of a session, over its production order (the live transcript
 * and its discarded branches, so a contract redo's discarded attempts count).
 * A run without a corrective prompt is not returned.
 */
export function contractRuns(transcript: readonly unknown[], branches: readonly ContractBranchInput[] = []): ContractRun[] {
  const items = chronology(transcript, branches);
  const runs: unknown[][] = [];
  let cur: unknown[] | undefined;
  for (const item of items) {
    if (item.kind !== "message") continue;
    const m = asObj(item.m);
    if (!m) continue;
    if (m["role"] === "user" && asObj(m["harness"])?.["kind"] === "record_turn") {
      if (cur) runs.push(cur);
      cur = undefined;
      continue;
    }
    if (isRunStart(m)) {
      if (cur) runs.push(cur);
      cur = [item.m];
      continue;
    }
    cur?.push(item.m);
  }
  if (cur) runs.push(cur);

  const out: ContractRun[] = [];
  runs.forEach((messages, run) => {
    const firstNudge = messages.findIndex((m) => nudgeOf(m) !== undefined);
    if (firstNudge < 0) return;
    const nudges = messages.filter((m) => nudgeOf(m) !== undefined).length;
    const errors = resultErrors(messages);

    // The first failed attempt: the last ending before the first nudge.
    let ending: Loose | undefined;
    let failedSend: string | undefined;
    for (let i = firstNudge - 1; i >= 0; i--) {
      const m = messages[i];
      if (!ending && isAssistantEnding(m)) ending = m;
    }
    for (let i = 0; i < firstNudge; i++) {
      for (const call of toolCallsOf(messages[i])) {
        if (isPostingTool(call.name) && errors.get(call.id) === true) failedSend = postedText(call.name, call.args) ?? failedSend;
      }
    }
    let firstAttempt = "";
    let firstAttemptSource: ContractRun["firstAttemptSource"] = "none";
    const endingText = ending ? assistantText(ending) : "";
    if (endingText && looksLikeTextualToolCall(endingText)) {
      firstAttempt = textualCallMessage(endingText) ?? endingText;
      firstAttemptSource = "textual_tool_call";
    } else if (failedSend?.trim()) {
      firstAttempt = failedSend;
      firstAttemptSource = "invalid_tool_call";
    } else if (endingText) {
      firstAttempt = endingText;
      firstAttemptSource = "text";
    }

    // After the first nudge: delivered sends, and how the run ended.
    const sent: string[] = [];
    for (let i = firstNudge + 1; i < messages.length; i++) {
      if (!isAssistantEnding(messages[i])) continue;
      for (const call of toolCallsOf(messages[i])) {
        if (!isPostingTool(call.name) || errors.get(call.id) !== false) continue;
        const text = postedText(call.name, call.args);
        if (text?.trim()) sent.push(text);
      }
    }
    let last: Loose | undefined;
    for (let i = messages.length - 1; i > firstNudge; i--) {
      if (isAssistantEnding(messages[i])) {
        last = messages[i] as Loose;
        break;
      }
    }
    const lastCalls = last ? toolCallsOf(last) : [];
    const silent =
      !!last &&
      !isIncomplete(last) &&
      (rawText(last) === "NO_REPLY" || lastCalls.some((c) => c.name === "no_reply"));
    const result: ContractRunResult = sent.length > 0 ? "sent" : silent ? "switched_to_no_reply" : "nothing";
    const endings: ContractRun["endings"] = [];
    for (const m of messages) {
      if (!isAssistantEnding(m) || typeof m["timestamp"] !== "number") continue;
      endings.push({ ts: m["timestamp"] as number, text: assistantText(m) });
    }
    out.push({
      run,
      nudges,
      endings,
      firstAttempt,
      firstAttemptSource,
      ts: ending && typeof ending["timestamp"] === "number" ? (ending["timestamp"] as number) : null,
      servedModel: (ending && servedModelOf(ending)) ?? null,
      wireModel: ending && typeof ending["model"] === "string" ? (ending["model"] as string) : null,
      sent,
      result,
    });
  });
  return out;
}

/** True when the text names a known tool as a bare word (a textual call the patterns may have missed). */
export function mentionsToolName(text: string, toolNames: readonly string[]): boolean {
  return toolNames.some((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
}
