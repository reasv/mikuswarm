/**
 * The duplicate-send check's mechanics (DECISION-MODEL §5.4; ARCHITECTURE.md
 * §8j "Duplicate sends"). Pure functions: what a session has seen of each
 * timeline, which messages of the same agent's other sessions it has not seen,
 * the judged state, and the agent-facing rejection.
 *
 * **Last seen.** A session sees a timeline through:
 * - its context build: the build stamps the transcript head with the build's
 *   cutoff (`seen: { timelineKey, upTo }`, the newest `receivedAt` it read; a
 *   redo rebuild reuses the first build's cutoff). The cutoff is the session's
 *   last-seen point for every timeline it never saw otherwise;
 * - a message that shows it more: a resume turn's gap backfill and an
 *   interjection's quoted message (`seen: { eventIds }`), or one that shows a
 *   room up to a point (`seen: { timelineKey, upTo }`);
 * - a previous rejection by this check that quoted messages: they count as seen
 *   while that rejection's tool result is on the live transcript (a fork that
 *   discards it discards what it showed).
 *
 * Everything is read back from the live messages (stamps are plain JSON fields
 * that persist with the transcript), so a resumed, revived or redone session
 * reads the right point without extra state.
 */
import type { CanonicalChatEvent } from "../types.js";
import { clipText, packNewest } from "../decisions/state.js";
import { parseTimelineKey } from "../storage/timeline-key.js";
import { DUPLICATE_QUESTION_TEXT, type DuplicateQuestionName } from "./builtin/duplicate.js";
import { headTokens, STATE_CLIPS } from "./state.js";

/** What a message showed the session (a JSON field on transcript messages). */
export interface SeenStamp {
  /** The timeline whose messages up to `upTo` (`receivedAt`) were shown. */
  timelineKey?: string;
  upTo?: number;
  /** Individual messages shown (timeline event ids). */
  eventIds?: string[];
}

/** What a session has seen, folded from its live messages. */
export interface SeenState {
  /** Per timeline: messages received at or before this were shown. */
  watermarks: Map<string, number>;
  /** The build cutoff: the last-seen point of a timeline with no watermark of its own. */
  since?: number;
  /** Individually shown messages. */
  eventIds: Set<string>;
}

/** What a message was answering: the request of its session, or nothing (a proactive post). */
export type Answering = { from: string; text: string } | "unprompted";

/** One unseen message of another session, as the check judges it. */
export interface UnseenMessage {
  /** The timeline event ids it spans (a long message split into chunks has several). */
  eventIds: string[];
  sessionId: string;
  /** When it was stored (the first chunk). */
  receivedAt: number;
  /** Its text, with `[image: <caption>]` for posted media. */
  text: string;
  answering: Answering;
}

/** Everything the duplicate questions of one send are judged on. */
export interface DuplicateContext {
  /** The timeline the call posts into. */
  targetTimelineKey: string;
  /** The session's own timeline. */
  ownTimelineKey: string;
  /** When the draft was judged (ms, the `receivedAt` clock). */
  draftAt: number;
  /** Unseen messages, oldest first (at most `[decisions.checks.duplicate].max_earlier`). */
  earlier: UnseenMessage[];
  draftAnswering: Answering;
  /** Clip of each earlier text (tokens). */
  earlierMaxTokens: number;
}

/** One stored bot message of another session, with that session's request. */
export interface DuplicateRow {
  /** Hydrated (captions on its attachments). */
  event: CanonicalChatEvent;
  sessionId: string;
  receivedAt: number;
  answering: Answering;
}

/** A tool result that quoted unseen messages carries this phrase. */
export const DUPLICATE_REJECTION_MARK = "that you have not seen";

type Loose = Record<string, unknown>;

function asObject(value: unknown): Loose | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Loose) : undefined;
}

function toolResultText(message: Loose): string {
  const content = message["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (asObject(b)?.["type"] === "text" && typeof asObject(b)?.["text"] === "string" ? (asObject(b)!["text"] as string) : ""))
    .join("");
}

/** The stamp on a message, if any. */
export function seenStampOf(message: unknown): SeenStamp | undefined {
  const seen = asObject(asObject(message)?.["seen"]);
  if (!seen) return undefined;
  const stamp: SeenStamp = {};
  if (typeof seen["timelineKey"] === "string") stamp.timelineKey = seen["timelineKey"];
  if (typeof seen["upTo"] === "number" && Number.isFinite(seen["upTo"])) stamp.upTo = seen["upTo"];
  if (Array.isArray(seen["eventIds"])) stamp.eventIds = seen["eventIds"].filter((id): id is string => typeof id === "string");
  return stamp;
}

/** `message` with `stamp` merged into its `seen` field (a new object; ids are unioned). */
export function withSeenStamp<T extends object>(message: T, stamp: SeenStamp): T {
  const prior = seenStampOf(message);
  const ids = [...new Set([...(prior?.eventIds ?? []), ...(stamp.eventIds ?? [])])];
  const merged: SeenStamp = {
    ...(prior ?? {}),
    ...(stamp.timelineKey !== undefined ? { timelineKey: stamp.timelineKey } : {}),
    ...(stamp.upTo !== undefined ? { upTo: stamp.upTo } : {}),
    ...(ids.length > 0 ? { eventIds: ids } : {}),
  };
  return { ...message, seen: merged };
}

/**
 * Fold a session's live messages into what it has seen. `rejections` maps a
 * tool call id to the messages its duplicate rejection quoted; they count as
 * seen while that call's tool result, carrying the rejection, is on the list.
 * A legacy transcript without a build stamp falls back to `fallbackSince`
 * (e.g. the session's start), else its head turn's timestamp.
 */
export function seenFromMessages(
  messages: readonly unknown[],
  rejections: ReadonlyMap<string, readonly string[]> = new Map(),
  fallbackSince?: number,
): SeenState {
  const state: SeenState = { watermarks: new Map(), eventIds: new Set() };
  let headTimestamp: number | undefined;
  for (const raw of messages) {
    const message = asObject(raw);
    if (!message) continue;
    const type = message["type"];
    if ((type === "triggerGroup" || type === "satellite") && headTimestamp === undefined && typeof message["timestamp"] === "number") {
      headTimestamp = message["timestamp"];
    }
    const stamp = seenStampOf(message);
    if (stamp) {
      if (stamp.timelineKey !== undefined && stamp.upTo !== undefined) {
        const prior = state.watermarks.get(stamp.timelineKey);
        state.watermarks.set(stamp.timelineKey, prior === undefined ? stamp.upTo : Math.max(prior, stamp.upTo));
        // The first build's cutoff is the default for every other timeline;
        // a later build (a redo) uses the same cutoff.
        if (state.since === undefined && (type === "triggerGroup" || type === "satellite")) state.since = stamp.upTo;
      }
      for (const id of stamp.eventIds ?? []) state.eventIds.add(id);
    }
    if (message["role"] === "toolResult" && typeof message["toolCallId"] === "string") {
      const quoted = rejections.get(message["toolCallId"]);
      if (quoted && toolResultText(message).includes(DUPLICATE_REJECTION_MARK)) {
        for (const id of quoted) state.eventIds.add(id);
      }
    }
  }
  if (state.since === undefined) state.since = fallbackSince ?? headTimestamp;
  if (state.since === undefined) delete state.since;
  return state;
}

/** The last-seen point of `timelineKey`: its own watermark, else the build cutoff. */
export function lastSeen(seen: SeenState, timelineKey: string): number | undefined {
  const own = seen.watermarks.get(timelineKey);
  if (own !== undefined && seen.since !== undefined) return Math.max(own, seen.since);
  return own ?? seen.since;
}

const CHUNK_ID = /^assistant:.+:(\d+)$/;

function mediaMarker(attachment: { mediaType: string; caption?: string }): string {
  const caption = attachment.caption?.replace(/\s+/g, " ").trim();
  return caption ? `[${attachment.mediaType}: ${caption}]` : `[${attachment.mediaType}]`;
}

/** A stored bot message as judged text: its body, then `[image: <caption>]` per posted attachment. */
export function messageText(event: CanonicalChatEvent): string {
  const parts: string[] = [];
  const body = (event.body ?? "").trim();
  if (body) parts.push(body);
  for (const attachment of event.attachments ?? []) parts.push(mediaMarker(attachment));
  return parts.join("\n");
}

/**
 * The unseen messages among `rows` (another session's bot messages in the
 * target timeline, received after the last-seen point, any order): drops the
 * ones already seen and the session's own, joins the chunks of one long
 * message, and keeps the newest `max`, oldest first.
 */
export function selectUnseen(
  rows: readonly DuplicateRow[],
  seen: SeenState,
  opts: { selfSessionId: string; max: number },
): UnseenMessage[] {
  const sorted = rows
    .filter((r) => r.sessionId !== opts.selfSessionId && !seen.eventIds.has(r.event.id))
    .sort((a, b) => a.receivedAt - b.receivedAt || a.event.id.localeCompare(b.event.id));
  const out: UnseenMessage[] = [];
  for (const row of sorted) {
    const text = messageText(row.event);
    const chunk = CHUNK_ID.exec(row.event.id);
    const previous = out[out.length - 1];
    if (chunk && Number(chunk[1]) > 0 && previous && previous.sessionId === row.sessionId) {
      previous.eventIds.push(row.event.id);
      if (text) previous.text = previous.text ? `${previous.text}\n${text}` : text;
      continue;
    }
    if (!text) continue;
    out.push({ eventIds: [row.event.id], sessionId: row.sessionId, receivedAt: row.receivedAt, text, answering: row.answering });
  }
  return out.slice(-Math.max(0, opts.max));
}

/** Whole seconds between an earlier message and the draft. */
export function secondsBefore(draftAt: number, receivedAt: number): number {
  return Math.max(0, Math.round((draftAt - receivedAt) / 1000));
}

function answeringState(answering: Answering): { from: string; text: string } | "unprompted" {
  if (answering === "unprompted") return "unprompted";
  return { from: answering.from, text: clipText(answering.text, STATE_CLIPS.request) };
}

/**
 * The judged state (DECISION-MODEL §5.4), packed to `budgetTokens`:
 * `{ earlier: [{ seconds_before_draft, answering, text }], draft: { answering, text } }`.
 * Nothing else: no persona, no room transcript, no tool results or reasoning.
 * Over budget, the oldest earlier messages go first, then the texts shrink.
 */
export function buildDuplicateState(ctx: DuplicateContext, draftText: string, budgetTokens: number): Record<string, unknown> {
  const draft = { answering: answeringState(ctx.draftAnswering), text: clipText(draftText, STATE_CLIPS.message) };
  const earlier = ctx.earlier.map((m) => ({
    seconds_before_draft: secondsBefore(ctx.draftAt, m.receivedAt),
    answering: answeringState(m.answering),
    text: headTokens(m.text.trim(), ctx.earlierMaxTokens),
  }));
  const build = (kept: typeof earlier) => ({ earlier: kept, draft });
  const kept = packNewest(earlier, budgetTokens, build);
  if (kept.length > 0 || earlier.length === 0) return build(kept);
  // Not even one message fits whole: keep the newest, its text and the draft shrunk evenly.
  const newest = earlier[earlier.length - 1]!;
  const share = Math.max(16, Math.floor((budgetTokens * 0.9) / 3));
  return {
    earlier: [{ ...newest, text: headTokens(newest.text, share) }],
    draft: { ...draft, text: headTokens(draft.text, share) },
  };
}

function answeringLine(answering: Answering): string {
  return answering === "unprompted" ? "(no request: the assistant posted on its own)" : `${answering.from}: ${answering.text}`;
}

/**
 * The judge-shaped conversation (DECISION-MODEL §3.8) for members that read
 * only `{ input, output }`: each earlier message as the request it answered
 * (user) and the message (assistant), oldest first, then the draft's request;
 * the draft is the output.
 */
export function buildDuplicateJudgeState(
  ctx: DuplicateContext,
  draftText: string,
  budgetTokens: number,
): { input: Array<{ role: "user" | "assistant"; content: string }>; output: { role: "assistant"; content: string } } {
  const share = Math.max(16, Math.floor(budgetTokens / (2 * ctx.earlier.length + 2)) - 8);
  const input: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of ctx.earlier) {
    input.push({ role: "user", content: headTokens(clipText(answeringLine(m.answering), STATE_CLIPS.request), share) });
    input.push({ role: "assistant", content: headTokens(headTokens(m.text.trim(), ctx.earlierMaxTokens), share) });
  }
  input.push({ role: "user", content: headTokens(clipText(answeringLine(ctx.draftAnswering), STATE_CLIPS.request), share) });
  return { input, output: { role: "assistant", content: headTokens(clipText(draftText, STATE_CLIPS.message), share) } };
}

/** Field references of the duplicate questions rewritten for the judge shape. */
export function duplicateJudgeText(text: string): string {
  return text
    .replaceAll("`draft.text`", "the assistant's output")
    .replaceAll("`draft.answering`", "the last user turn")
    .replaceAll("`earlier[*].text`", "the assistant's earlier messages in the input")
    .replaceAll("`earlier[*].answering`", "the user turns before them")
    .replaceAll("`answering`", "the user turn before each message");
}

/**
 * The timeline a posting call targets: the session's own for `send_message`,
 * `edit_message` and `create_poll`, the `channel` of `send_to_channel`, and
 * the existing DM with `user` for `send_dm` (`resolveDm`; none yet = no
 * earlier messages). Undefined when it cannot be known.
 */
export function duplicateTarget(
  toolName: string,
  args: Record<string, unknown> | undefined,
  ownTimelineKey: string,
  resolveDm?: (userId: string) => string | undefined,
): string | undefined {
  switch (toolName) {
    case "send_message":
    case "edit_message":
    case "create_poll":
      return ownTimelineKey;
    case "send_to_channel": {
      const channel = typeof args?.["channel"] === "string" ? args["channel"].trim() : "";
      return channel || undefined;
    }
    case "send_dm": {
      const user = typeof args?.["user"] === "string" ? args["user"].trim() : "";
      return user && resolveDm ? resolveDm(user) : undefined;
    }
    default:
      return undefined;
  }
}

/** How long ago, for the agent: "12 s", "4 min", "2 h". */
export function agoLabel(seconds: number): string {
  if (seconds < 120) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

/** Longest quote of an earlier message in the rejection (chars). */
const QUOTE_MAX_CHARS = 1500;
/** Longest quote of what it was answering (chars). */
const ANSWERING_QUOTE_MAX_CHARS = 300;

const SINGLE_CLAUSE: Record<DuplicateQuestionName, string> = {
  answered_already: "answers the same question it already answered",
  repeats: "repeats what that message already says",
  contradicts: "contradicts it",
};
const MULTI_CLAUSE: Record<DuplicateQuestionName, string> = {
  answered_already: "answers a question one of them already answered",
  repeats: "repeats what one of them already says",
  contradicts: "contradicts one of them",
};

function joinClauses(clauses: string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? "";
  return `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;
}

function quote(text: string, max: number): string {
  return `«${clipText(text, max)}»`;
}

function placeOf(ctx: DuplicateContext): { here: string; room: string } {
  if (ctx.targetTimelineKey !== ctx.ownTimelineKey) {
    return { here: `in ${ctx.targetTimelineKey}`, room: `in ${ctx.targetTimelineKey}` };
  }
  const kind = parseTimelineKey(ctx.ownTimelineKey)?.kind;
  return { here: "here", room: kind === "dm" ? "in this DM" : "in this room" };
}

function answeredClause(answering: Answering): string {
  return answering === "unprompted"
    ? "it was not answering anyone: you posted it on your own"
    : `it was answering ${answering.from}: ${quote(answering.text, ANSWERING_QUOTE_MAX_CHARS)}`;
}

/**
 * The tool error of a send the duplicate check blocked (DECISION-MODEL §5.4).
 * It names the actor (another session of the same agent, in parallel), quotes
 * the unseen messages and what they answered, and says which question fired.
 * `standalone` is the whole error when this check alone blocks;
 * `explanation` is its line in a combined revise error (no override sentence:
 * the combined error has its own).
 */
export function duplicateRejection(
  ctx: DuplicateContext,
  firedQuestions: readonly string[],
  code: string,
): { explanation: string; standalone: string } {
  const { here, room } = placeOf(ctx);
  const single = ctx.earlier.length === 1;
  const clauseOf = (name: string) => {
    const table = single ? SINGLE_CLAUSE : MULTI_CLAUSE;
    if (name in table) return table[name as DuplicateQuestionName];
    const statement = (DUPLICATE_QUESTION_TEXT as Record<string, string>)[name];
    return statement ? statement : `fails the "${name}" check`;
  };
  const clauses = joinClauses([...new Set(firedQuestions)].map(clauseOf)) || (single ? SINGLE_CLAUSE.repeats : MULTI_CLAUSE.repeats);
  let body: string;
  if (single) {
    const m = ctx.earlier[0]!;
    const who = m.answering === "unprompted"
      ? "you, posting on your own in parallel"
      : `you, answering a different message ${room} in parallel`;
    body =
      `Another session of yours (${who}) already posted a message ${here} ` +
      `${agoLabel(secondsBefore(ctx.draftAt, m.receivedAt))} ago ${DUPLICATE_REJECTION_MARK}: ` +
      `${quote(m.text, QUOTE_MAX_CHARS)} (${answeredClause(m.answering)}). Your draft ${clauses}.`;
  } else {
    const lines = ctx.earlier.map(
      (m) =>
        `- ${agoLabel(secondsBefore(ctx.draftAt, m.receivedAt))} ago: ${quote(m.text, QUOTE_MAX_CHARS)} ` +
        `(${answeredClause(m.answering)})`,
    );
    body =
      `Other sessions of yours (you, answering different messages ${room} in parallel) already posted ` +
      `${ctx.earlier.length} messages ${here} ${DUPLICATE_REJECTION_MARK}:\n${lines.join("\n")}\nYour draft ${clauses}.`;
  }
  const rewrite =
    `Rewrite your message so it fits after ${single ? "that one" : "them"}: refer to it, correct it, or add only ` +
    "what is new. Call no_reply if nothing is left to add.";
  return {
    explanation: `${body} ${rewrite}`,
    standalone:
      `Not sent. ${body} ${rewrite} If your draft is still right as written, send it again with ` +
      `override_checks: ["${code}"].`,
  };
}
