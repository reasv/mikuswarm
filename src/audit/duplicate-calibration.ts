/**
 * Calibration items for the duplicate-send check (DECISION-MODEL §5.4,
 * ARCHITECTURE.md §9i "Calibration tool"), rebuilt from history: every posting
 * call of a chat session (delivered, or blocked by a duplicate rejection) whose
 * target timeline holds bot messages of the same agent's other sessions that
 * the session had not seen when it drafted the call, the newest of them within
 * `windowMs` of the draft (two sessions that sent close together, where the
 * drafting session's context was built before the other's send).
 *
 * The item carries the same `{ earlier, draft }` context the live gate builds:
 * last seen from the session's transcript up to the call (its build stamp,
 * else the session's start for a transcript older than the stamps; quoted
 * interjections; earlier duplicate rejections, from its decision rows), the
 * unseen messages' text with `[image: <caption>]`, and what each answered.
 * Reads only; never message text in any output (the caller prints ids).
 */
import type Database from "better-sqlite3";
import { isHarnessMade } from "../agent/harness.js";
import { SYNTHETIC_SESSION_TYPES } from "../agent/recovery.js";
import { DEFAULT_DUPLICATE_EARLIER_MAX_TOKENS, DEFAULT_DUPLICATE_MAX_EARLIER } from "../decisions/config.js";
import { answeringOfSession, priorDuplicateRejections } from "../checks/duplicate-source.js";
import {
  DUPLICATE_REJECTION_MARK,
  duplicateTarget,
  lastSeen,
  seenFromMessages,
  selectUnseen,
  type DuplicateContext,
  type DuplicateRow,
} from "../checks/duplicate.js";
import { postedText } from "../checks/state.js";
import { buildTimelineKey, parseTimelineKey } from "../storage/timeline-key.js";
import { isPostingTool } from "../tools/side-effects.js";
import type { AttachmentMeta, CanonicalChatEvent } from "../types.js";
import type { CalibrationItem, SampleResult } from "./calibration.js";
import { seededRandom } from "./calibration.js";
import { parseTranscript } from "./transcript.js";

export interface DuplicateSampleOptions {
  sample: number;
  seed: number;
  /** Only sessions created at or after this time (ms). */
  since?: number;
  /** The newest unseen message must be at most this old at the draft. Default 60 s. */
  windowMs?: number;
  maxEarlier?: number;
  earlierMaxTokens?: number;
  /** `[proactive].session_type` (default `proactive`). */
  proactiveSessionType?: string;
  /** Only outputs a duplicate check already fired on (a live rejection or a check row). */
  firedOnly?: boolean;
  /** The duplicate check codes (for `firedOnly` and earlier rejections). Default `duplicate`. */
  codes?: ReadonlySet<string>;
}

export const DEFAULT_DUPLICATE_WINDOW_MS = 60_000;

type Loose = Record<string, unknown>;

function asObj(value: unknown): Loose | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Loose) : undefined;
}

interface MessageRow {
  id: string;
  timeline_key: string;
  agent_session_id: string;
  received_at: number;
  event_json: string;
  session_type: string | null;
  trigger_event_id: string | null;
  trigger_body: string | null;
  trigger_sender_id: string | null;
  trigger_sender_display_name: string | null;
  session_timeline_key: string | null;
}

interface SessionRow {
  id: string;
  timeline_key: string;
  started_at: number | null;
  created_at: number;
  transcript_json: string | null;
}

/** Attachment captions of stored messages (role `attachment`, by source index). */
function attachmentsOf(db: Database.Database, eventIds: readonly string[]): Map<string, AttachmentMeta[]> {
  const out = new Map<string, AttachmentMeta[]>();
  const statement = db.prepare(
    `select media_type, caption from media_assets where event_id = ? and role = 'attachment' order by source_index`,
  );
  for (const id of eventIds) {
    const rows = statement.all(id) as Array<{ media_type: string; caption: string | null }>;
    if (rows.length > 0) {
      out.set(id, rows.map((r) => ({ mediaType: r.media_type as AttachmentMeta["mediaType"], ...(r.caption ? { caption: r.caption } : {}) }) as AttachmentMeta));
    }
  }
  return out;
}

/** The posting calls of a transcript the check would have judged: delivered, or blocked as a duplicate. */
function postingCalls(transcript: readonly unknown[]): Array<{ index: number; id: string; name: string; args: Loose; ts: number }> {
  const results = new Map<string, { error: boolean; text: string }>();
  for (const raw of transcript) {
    const m = asObj(raw);
    if (m?.["role"] !== "toolResult" || typeof m["toolCallId"] !== "string") continue;
    const content = Array.isArray(m["content"]) ? (m["content"] as unknown[]) : [];
    const text = content.map((b) => (typeof asObj(b)?.["text"] === "string" ? (asObj(b)!["text"] as string) : "")).join("");
    results.set(m["toolCallId"], { error: m["isError"] === true || /^error\b/i.test(text.trimStart()), text });
  }
  const out: Array<{ index: number; id: string; name: string; args: Loose; ts: number }> = [];
  transcript.forEach((raw, index) => {
    const m = asObj(raw);
    if (m?.["role"] !== "assistant" || isHarnessMade(m) || typeof m["timestamp"] !== "number") return;
    const content = Array.isArray(m["content"]) ? (m["content"] as unknown[]) : [];
    for (const block of content) {
      const b = asObj(block);
      if (b?.["type"] !== "toolCall" || typeof b["id"] !== "string" || typeof b["name"] !== "string") continue;
      if (!isPostingTool(b["name"])) continue;
      const result = results.get(b["id"]);
      if (!result) continue;
      if (result.error && !result.text.includes(DUPLICATE_REJECTION_MARK)) continue;
      out.push({ index, id: b["id"], name: b["name"], args: asObj(b["arguments"]) ?? {}, ts: m["timestamp"] as number });
    }
  });
  return out;
}

/** The DM timelines of `userId` on the account of `ownTimelineKey` (the newest first). */
function dmTimeline(db: Database.Database, ownTimelineKey: string, userId: string): string | undefined {
  const parsed = parseTimelineKey(ownTimelineKey);
  if (!parsed) return undefined;
  const peer = db
    .prepare(`select dm_channel_id from dm_peers where provider = ? and account_id = ? and peer_user_id = ? limit 1`)
    .get(parsed.provider, parsed.accountId, userId) as { dm_channel_id: string } | undefined;
  if (peer) return buildTimelineKey({ provider: parsed.provider, accountId: parsed.accountId, kind: "dm", channelId: peer.dm_channel_id });
  const prefix = `${parsed.provider}:${parsed.accountId}:dm:`;
  const row = db
    .prepare(
      `select timeline_key from timeline_events where sender_id = ? and substr(timeline_key, 1, ?) = ?
        order by timestamp desc limit 1`,
    )
    .get(userId, prefix.length, prefix) as { timeline_key: string } | undefined;
  return row?.timeline_key;
}

/**
 * Sample the duplicate check's historical items (seeded reservoir). `eligible`
 * counts the calls that had unseen messages within the window; `sessions` the
 * chat sessions scanned.
 */
export function sampleDuplicateItems(db: Database.Database, opts: DuplicateSampleOptions): SampleResult {
  const since = opts.since ?? 0;
  const windowMs = opts.windowMs ?? DEFAULT_DUPLICATE_WINDOW_MS;
  const maxEarlier = opts.maxEarlier ?? DEFAULT_DUPLICATE_MAX_EARLIER;
  const earlierMaxTokens = opts.earlierMaxTokens ?? DEFAULT_DUPLICATE_EARLIER_MAX_TOKENS;
  const proactiveType = opts.proactiveSessionType ?? "proactive";
  const codes = opts.codes ?? new Set(["duplicate"]);
  const rand = seededRandom(opts.seed);

  // Every stored bot message of a session, per timeline, oldest first.
  const byTimeline = new Map<string, MessageRow[]>();
  const messages = db
    .prepare(
      `select te.id, te.timeline_key, te.agent_session_id, te.received_at, te.event_json,
              s.session_type, s.trigger_event_id, s.trigger_body, s.trigger_sender_id,
              s.trigger_sender_display_name, s.timeline_key as session_timeline_key
         from timeline_events te join agent_sessions s on s.id = te.agent_session_id
        where te.role = 'assistant' and te.received_at >= ?
        order by te.received_at, te.id`,
    )
    .iterate(since) as IterableIterator<MessageRow>;
  for (const row of messages) {
    const list = byTimeline.get(row.timeline_key);
    if (list) list.push(row);
    else byTimeline.set(row.timeline_key, [row]);
  }

  const types = [...SYNTHETIC_SESSION_TYPES];
  const sessions = db
    .prepare(
      `select s.id, s.timeline_key, s.started_at, s.created_at, p.transcript_json
         from agent_sessions s join agent_session_payloads p on p.session_id = s.id
        where p.transcript_json is not null and s.created_at >= ?
          and s.session_type not in (${types.map(() => "?").join(", ")})
        order by s.created_at, s.id`,
    )
    .all(since, ...types) as SessionRow[];
  const ownSession = db.prepare(
    `select session_type, trigger_event_id, trigger_body, trigger_sender_id, trigger_sender_display_name, timeline_key
       from agent_sessions where id = ?`,
  );
  const decisionRows = db.prepare(
    `select point, tool_call_id, branch_no, verdict_json, consequence from decision_evaluations
      where agent_session_id = ? and point = 'checks'`,
  );

  const reservoir: CalibrationItem[] = [];
  let eligible = 0;
  let scanned = 0;
  for (const session of sessions) {
    scanned += 1;
    const transcript = parseTranscript(session.transcript_json);
    if (!transcript) continue;
    const calls = postingCalls(transcript);
    if (calls.length === 0) continue;
    const rows = decisionRows.all(session.id) as Array<{
      point: string;
      tool_call_id: string | null;
      branch_no: number | null;
      verdict_json: string | null;
      consequence: string | null;
    }>;
    const rejections = priorDuplicateRejections(rows, codes);
    const fired = new Set(rejections.keys());
    for (const call of calls) {
      if (opts.firedOnly && !fired.has(call.id)) continue;
      const draft = postedText(call.name, call.args);
      if (!draft?.trim()) continue;
      const target = duplicateTarget(call.name, call.args, session.timeline_key, (user) => dmTimeline(db, session.timeline_key, user));
      if (!target) continue;
      const seen = seenFromMessages(transcript.slice(0, call.index), rejections, session.started_at ?? session.created_at);
      const after = lastSeen(seen, target);
      if (after === undefined) continue;
      const candidates = (byTimeline.get(target) ?? []).filter(
        (r) => r.received_at > after && r.received_at < call.ts && r.agent_session_id !== session.id,
      );
      if (candidates.length === 0) continue;
      const captions = attachmentsOf(db, candidates.map((r) => r.id));
      const duplicateRows: DuplicateRow[] = candidates.map((r) => {
        const event = JSON.parse(r.event_json) as CanonicalChatEvent;
        const attachments = captions.get(r.id);
        return {
          event: attachments ? { ...event, attachments } : event,
          sessionId: r.agent_session_id,
          receivedAt: r.received_at,
          answering: answeringOfSession(
            r.session_timeline_key === null
              ? null
              : {
                  timelineKey: r.session_timeline_key,
                  sessionType: r.session_type ?? "default",
                  triggerEventId: r.trigger_event_id,
                  triggerBody: r.trigger_body,
                  triggerSenderId: r.trigger_sender_id,
                  triggerSenderDisplayName: r.trigger_sender_display_name,
                },
            proactiveType,
          ),
        };
      });
      const earlier = selectUnseen(duplicateRows, seen, { selfSessionId: session.id, max: maxEarlier, asOf: call.ts });
      const newest = earlier[earlier.length - 1];
      if (!newest || call.ts - newest.receivedAt > windowMs) continue;
      const own = ownSession.get(session.id) as {
          session_type: string;
          trigger_event_id: string | null;
          trigger_body: string | null;
          trigger_sender_id: string | null;
          trigger_sender_display_name: string | null;
          timeline_key: string;
        };
      const duplicate: DuplicateContext = {
        targetTimelineKey: target,
        ownTimelineKey: session.timeline_key,
        draftAt: call.ts,
        earlier,
        draftAnswering: answeringOfSession(
          {
            timelineKey: own.timeline_key,
            sessionType: own.session_type,
            triggerEventId: own.trigger_event_id,
            triggerBody: own.trigger_body,
            triggerSenderId: own.trigger_sender_id,
            triggerSenderDisplayName: own.trigger_sender_display_name,
          },
          proactiveType,
        ),
        earlierMaxTokens,
      };
      const item: CalibrationItem = {
        id: `${session.id}:${call.id}`,
        sessionId: session.id,
        checkpoint: "send",
        context: { checkpoint: "send", action: call.name, duplicate },
        sources: { message: draft },
      };
      eligible += 1;
      if (reservoir.length < opts.sample) reservoir.push(item);
      else {
        const j = Math.floor(rand() * eligible);
        if (j < opts.sample) reservoir[j] = item;
      }
    }
  }
  return { items: reservoir, knownPositives: [], eligible, sessions: scanned };
}
