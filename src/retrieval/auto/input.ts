/**
 * The pipeline input from timeline events (ARCHITECTURE.md §9d "Judged
 * retrieval"): built at session launch from the trigger group, its reply
 * target and the conversation before it, or by the context builder for a
 * build that was not planned at launch (room previews).
 */
import type { CanonicalChatEvent } from "../../types.js";
import type { DecisionAttribution } from "../../decisions/registry.js";
import { senderName, toTranscriptMessage } from "../../decisions/transcript.js";
import { deletedPlaceholder } from "../../timeline/deletions.js";
import type { PlanInput, PlanParticipant } from "./types.js";

/** Messages of conversation the input carries (the point and the window query take their tails). */
export const PLAN_CONVERSATION_MESSAGES = 12;
const CHAT_CLIP = 400;

export interface BuildPlanInputOptions {
  agentName: string | null;
  timelineKey: string;
  attribution: DecisionAttribution;
  triggerEventId?: string | null;
  proactive: boolean;
  now: number;
  /** The trigger group (empty for proactive), oldest first. */
  triggerEvents: CanonicalChatEvent[];
  /** The stored reply target, when the trigger is a reply and it is stored. */
  replyTarget?: CanonicalChatEvent;
  /** Messages before the request, oldest first. */
  recent: CanonicalChatEvent[];
  /** `auto.query_messages`: the conversation tail whose senders are active people. */
  queryMessages?: number;
  signal?: AbortSignal;
}

export function buildPlanInput(opts: BuildPlanInputOptions): PlanInput {
  const humans = opts.triggerEvents.filter((e) => !e.sender?.isSelf && e.role !== "assistant");
  const first = humans[0] ?? opts.triggerEvents[0];
  const requestText = opts.triggerEvents
    .map((e) => (e.deleted ? "" : (e.body ?? "")))
    .filter((t) => t.trim().length > 0)
    .join("\n");
  const reply = opts.replyTarget;
  const snapshot = first?.replyTo;
  let replyTo: { from: string; text: string } | undefined;
  if (reply) {
    replyTo = { from: senderName(reply.sender), text: reply.deleted ? deletedPlaceholder(reply.deleted, reply.sender?.id) : (reply.body ?? "") };
  } else if (snapshot && (snapshot.body || snapshot.deleted)) {
    replyTo = {
      from: senderName(snapshot.sender),
      text: snapshot.deleted ? deletedPlaceholder(snapshot.deleted, snapshot.sender?.id) : (snapshot.body ?? ""),
    };
  }

  const participants: PlanParticipant[] = [];
  const seen = new Set<string>();
  const push = (p: PlanParticipant) => {
    const key = `${p.provider}\0${p.senderId}`;
    if (seen.has(key)) return;
    seen.add(key);
    participants.push(p);
  };
  const nameOf = (provider: string, id: string): { name: string; username?: string } => {
    const known = [...opts.recent, ...opts.triggerEvents].reverse().find((e) => e.provider === provider && e.sender?.id === id);
    return known ? { name: senderName(known.sender), ...(known.sender.username ? { username: known.sender.username } : {}) } : { name: id };
  };
  if (!opts.proactive) {
    for (const e of humans) {
      if (!e.sender?.id) continue;
      push({
        provider: e.provider,
        senderId: e.sender.id,
        name: senderName(e.sender),
        ...(e.sender.username ? { username: e.sender.username } : {}),
        role: "requester",
      });
    }
    const replySender = reply?.sender ?? snapshot?.sender;
    if (replySender?.id && !replySender.isSelf && reply?.role !== "assistant") {
      push({
        provider: reply?.provider ?? first?.provider ?? "",
        senderId: replySender.id,
        name: senderName(replySender),
        ...(replySender.username ? { username: replySender.username } : {}),
        role: "reply_author",
      });
    }
    for (const e of humans) {
      for (const id of e.mentions?.mentionedUserIds ?? []) {
        const n = nameOf(e.provider, id);
        push({ provider: e.provider, senderId: id, ...n, role: "mentioned" });
      }
    }
  }

  // Person-cued recall (§9d): every participant plus the human senders of the
  // last `queryMessages` messages.
  const activePeople = participants.map((p) => ({ provider: p.provider, senderId: p.senderId, name: p.name }));
  const activeSeen = new Set(activePeople.map((p) => `${p.provider}\0${p.senderId}`));
  for (const e of opts.recent.slice(-(opts.queryMessages ?? 6)).reverse()) {
    if (e.sender?.isSelf || e.role === "assistant" || e.sender?.isBot || !e.sender?.id) continue;
    const key = `${e.provider}\0${e.sender.id}`;
    if (activeSeen.has(key)) continue;
    activeSeen.add(key);
    activePeople.push({ provider: e.provider, senderId: e.sender.id, name: senderName(e.sender) });
  }

  const conversation = opts.recent.slice(-PLAN_CONVERSATION_MESSAGES).map((e) => {
    const m = toTranscriptMessage(e, CHAT_CLIP, { deletedPlaceholder: true });
    return { from: m.from, text: m.text, ...(m.self ? { self: true as const } : {}) };
  });

  return {
    agentName: opts.agentName,
    timelineKey: opts.timelineKey,
    attribution: opts.attribution,
    triggerEventId: opts.triggerEventId ?? null,
    proactive: opts.proactive,
    now: opts.now,
    ...(opts.proactive || !first || requestText.trim().length === 0
      ? {}
      : { request: { from: senderName(first.sender), text: requestText, ...(replyTo ? { replyTo } : {}) } }),
    conversation,
    participants: participants.filter((p) => p.provider.length > 0),
    activePeople: activePeople.filter((p) => p.provider.length > 0),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
}
