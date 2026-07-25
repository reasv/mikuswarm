/**
 * `ChannelClient` adapter for Matrix (spec DISCORD-SUPPORT-DESIGN §7.1).
 *
 * Wraps a `MatrixNativeClient` + a fixed `roomId` and exposes the cross-provider
 * `ChannelClient` interface. Constructed by `MatrixProvider.channelClient()` and
 * passed into tools instead of the raw native client.
 *
 * The Matrix provider has `membershipRoster: true`, `pollCreate: true`, and
 * `pollVote: true`, so `members`, `createPoll`, and `votePoll` are all present.
 */
import type {
  ChannelClient,
  ChannelInfo,
  CreatePollRequest,
  CreatePollResult,
  EmojiEntry,
  HistoryPageRequest,
  HistoryPageResult,
  HistorySummary,
  MemberInfo,
  PinnedMessage,
  ReactionListing,
  SenderInfo,
  VotePollRequest,
  VotePollResult,
} from "../types.js";
import type { MatrixNativeClient } from "./native-client.js";

export class MatrixChannelClient implements ChannelClient {
  readonly #client: MatrixNativeClient;
  readonly #roomId: string;

  constructor(client: MatrixNativeClient, roomId: string) {
    this.#client = client;
    this.#roomId = roomId;
  }

  async react(externalId: string, emoji: string): Promise<{ display?: string } | void> {
    const result = await this.#client.reactMessage({ roomId: this.#roomId, messageId: externalId, key: emoji, remove: false });
    return { display: result.reaction?.display };
  }

  async unreact(externalId: string, emoji: string): Promise<{ removed?: number } | void> {
    const result = await this.#client.reactMessage({ roomId: this.#roomId, messageId: externalId, key: emoji, remove: true });
    return { removed: result.removed };
  }

  async listReactions(externalId: string, limit?: number): Promise<ReactionListing> {
    const reactions = await this.#client.listReactions({ roomId: this.#roomId, messageId: externalId, limit });
    return reactions.map((r) => ({
      normalizedKey: r.normalizedKey,
      display: r.display,
      kind: r.kind,
      shortcode: r.shortcode,
      count: r.count,
      users: r.users,
    }));
  }

  async editMessage(externalId: string, body: string): Promise<{ externalId?: string } | void> {
    const result = await this.#client.editMessage({ roomId: this.#roomId, messageId: externalId, text: body });
    return { externalId: result.eventId };
  }

  async deleteMessage(externalId: string, reason?: string): Promise<void> {
    await this.#client.deleteMessage({ roomId: this.#roomId, messageId: externalId, reason });
  }

  async readMessages(req: HistoryPageRequest): Promise<HistoryPageResult> {
    const result = await this.#client.readMessages({
      roomId: this.#roomId,
      limit: req.limit,
      before: req.before ?? req.cursor,
      after: req.after,
    });
    return {
      messages: result.messages.map(toHistorySummary),
      nextCursor: result.nextBatch ?? undefined,
      prevCursor: result.prevBatch ?? undefined,
    };
  }

  /** Fetch all backed-up megolm sessions for this room (HistoryClient.downloadRoomKeys). */
  async downloadRoomKeys(): Promise<void> {
    await this.#client.downloadRoomKeysForRoom(this.#roomId);
  }

  async readMessage(externalId: string): Promise<HistorySummary | undefined> {
    const summary = await this.#client.messageSummary({ roomId: this.#roomId, eventId: externalId });
    if (!summary) return undefined;
    return toHistorySummary(summary);
  }

  async memberInfo(userId: string): Promise<MemberInfo | undefined> {
    const info = await this.#client.memberInfo({ roomId: this.#roomId, userId });
    return {
      userId: info.userId,
      displayName: info.displayName,
      avatarUrl: info.avatarUrl,
      membership: info.membership,
      isSelf: info.isSelf,
      isDirect: info.isDirect,
    };
  }

  async members(): Promise<SenderInfo[]> {
    const members = await this.#client.roomMembers({ roomId: this.#roomId });
    return members.map((m) => ({
      id: m.userId,
      displayName: m.displayName,
    }));
  }

  async channelInfo(): Promise<ChannelInfo> {
    const info = await this.#client.channelInfo({ roomId: this.#roomId });
    const base = info.displayName ?? info.canonicalAlias ?? info.roomId;
    const label = info.parentSpaceName ? `${base} (${info.parentSpaceName})` : base;
    return {
      label,
      displayName: info.displayName,
      channelId: info.roomId,
      isDirect: info.isDirect,
      memberCount: info.memberCount,
      joined: info.joined,
      canonicalAlias: info.canonicalAlias,
      altAliases: info.altAliases,
    };
  }

  async pins(): Promise<PinnedMessage[]> {
    const result = await this.#client.listPins({ roomId: this.#roomId });
    return result.events.map((ev) => ({
      externalId: ev.eventId,
      sender: { id: ev.sender, displayName: ev.senderName },
      body: ev.body,
      timestamp: /^\d+$/.test(ev.timestamp) ? Number(ev.timestamp) : new Date(ev.timestamp).getTime(),
    }));
  }

  async pinMessage(externalId: string): Promise<{ pinCount?: number } | void> {
    const result = await this.#client.pinMessage({ roomId: this.#roomId, messageId: externalId });
    return { pinCount: result.pinned.length };
  }

  async unpinMessage(externalId: string): Promise<{ pinCount?: number } | void> {
    const result = await this.#client.unpinMessage({ roomId: this.#roomId, messageId: externalId });
    return { pinCount: result.pinned.length };
  }

  async emojiList(limit = 50): Promise<EmojiEntry[]> {
    const shortcodes = this.#client.listKnownShortcodes({ roomId: this.#roomId, limit });
    // listKnownShortcodes returns `:name:`-wrapped strings; strip the wrapping
    // colons so EmojiEntry.shortcode is the bare name. The tool renders `:name:`
    // itself, so leaving the colons in would produce `::name::`.
    return shortcodes.map((s) => ({
      shortcode: s.startsWith(":") && s.endsWith(":") && s.length > 2 ? s.slice(1, -1) : s,
    }));
  }

  async createPoll(req: CreatePollRequest): Promise<CreatePollResult> {
    const result = await this.#client.createPoll({
      roomId: this.#roomId,
      question: req.question,
      answers: req.options.map((o) => ({ id: o.id, text: o.text })),
      maxSelections: req.maxSelections,
    });
    return { externalId: result.eventId };
  }

  async votePoll(req: VotePollRequest): Promise<VotePollResult> {
    const result = await this.#client.pollVote({
      roomId: this.#roomId,
      pollEventId: req.pollExternalId,
      answerIds: req.answerIds,
    });
    return { externalId: result.eventId };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

import type { MatrixMessageSummary } from "./native-types.js";
import { mediaToAttachment } from "./inbound.js";
import type { BackfillReadClient } from "../backfill/paginate.js";

function toHistorySummary(m: MatrixMessageSummary): HistorySummary {
  const relType = m.relatesTo?.relType;
  const relEventId = m.relatesTo?.eventId;
  return {
    externalId: m.eventId,
    sender: { id: m.sender, displayName: m.senderName },
    timestamp: /^\d+$/.test(m.timestamp) ? Number(m.timestamp) : new Date(m.timestamp).getTime(),
    body: m.body,
    attachments: m.media ? m.media.map((media) => mediaToAttachment(m.eventId, media)) : undefined,
    replyToExternalId: !relType && relEventId ? relEventId : undefined,
    edited: relType === "m.replace",
    editTargetExternalId: relType === "m.replace" ? relEventId : undefined,
    threadRootExternalId: relType === "m.thread" ? relEventId : undefined,
    undecryptable: m.undecryptable ? true : undefined,
    sessionId: m.sessionId,
    utdReason: m.utdReason,
  };
}

/**
 * Build a `BackfillReadClient` scoped to one room, backed by a native Matrix
 * client. The roomId is captured in the closure so the neutral `HistoryPageRequest`
 * (which carries no roomId) can be forwarded verbatim to the room-agnostic
 * paginator while the native call still receives the correct room.
 */
export function makeBackfillReadClient(nativeClient: MatrixNativeClient, roomId: string): BackfillReadClient {
  return {
    readMessages: (req) =>
      nativeClient
        .readMessages({ roomId, limit: req.limit, before: req.before ?? req.cursor, after: req.after })
        .then((result) => ({
          messages: result.messages.map(toHistorySummary),
          nextCursor: result.nextBatch ?? undefined,
          prevCursor: result.prevBatch ?? undefined,
        })),
    downloadRoomKeysForRoom: (rId) => nativeClient.downloadRoomKeysForRoom(rId),
  };
}
