/**
 * Cross-channel messaging tools (spec CROSS-CHANNEL-MESSAGING §4).
 *
 * All five tools are DEFERRED — they live in the session catalog but are only
 * activated when the `contacts` skill (or `chat-history` for the two roster
 * tools) is loaded. No immediate-core additions (§9 design rationale).
 *
 * Tools:
 *   send_dm          — DM a user; opens the channel if needed (§4.1)
 *   send_to_channel  — Send into another joined channel (§4.2)
 *   list_members     — Roster listing + set ops + directory search (§4.3)
 *   list_channels    — Enumerate the bot's joined channels (§4.4)
 *   dm_optout        — Self-service opt-out/in for agent-initiated DMs (§4.5)
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type {
  CanonicalChatEvent,
  IChatProvider,
  InboundChatEvent,
  OutboundTarget,
  ProviderTerminology,
  SenderInfo,
} from "../types.js";
import type { TimelineStore } from "../timeline/index.js";
import { parseTimelineKey } from "../timeline/index.js";
import type { Storage } from "../storage/index.js";
import type { ChannelVisibilityResolver } from "../visibility/index.js";
import { chunkMarkdownText } from "./chunk.js";
import { MATRIX_TERMINOLOGY } from "./terminology.js";
import { formatAgentTimestamp } from "../time/index.js";

// ── Context ───────────────────────────────────────────────────────────────────

export interface CrossChannelToolContext {
  /** The session's primary IChatProvider (used to open DMs, list channels). */
  provider: IChatProvider;
  /** The full provider registry (for send_to_channel to reach other providers). */
  providers: ReadonlyMap<string, IChatProvider>;
  /** The session's outbound target (current channel). */
  target: OutboundTarget;
  /** The inbound event that triggered this session (source of sender id / provider). */
  inbound: InboundChatEvent;
  /** The session's id — auto-stamped into cross_channel metadata. */
  sessionId: string;
  /** For ingestAssistantSend on outbound events. */
  timeline: TimelineStore;
  /** For opt-out reads/writes and identity search. */
  storage: Storage;
  /** For filtering isolated channels out of lists/errors. */
  visibilityResolver: ChannelVisibilityResolver;
  /** Whether the [messaging] block has enabled=true (master switch). */
  messagingEnabled: boolean;
  /** Whether dm_initiation is enabled (gates send_dm). */
  dmInitiationEnabled: boolean;
  /** Bot's self-sender in this provider/account (for stamping outbound events). */
  selfSender?: SenderInfo;
  /** The stable user id of the session's trigger sender (for dm_optout auth). */
  triggerSenderId: string;
  /**
   * Resume generation at run start (spec RESUMABLE-SESSIONS §6). Threaded into
   * outbound events exactly as send_message does.
   */
  agentSessionGeneration?: number;
  terminology?: ProviderTerminology;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Simple session-scoped message stash: short handles (m1, m2, …) → body text.
 * Dies with the session as required by §5.2 — this Map is created once per
 * `createCrossChannelTools` call and captured by closure in all five tool factories.
 */
function makeMessageStash(): {
  store(body: string): string;
  recall(ref: string): string | undefined;
} {
  const stash = new Map<string, string>();
  let counter = 0;
  return {
    store(body: string): string {
      counter += 1;
      const ref = `m${counter}`;
      stash.set(ref, body);
      return ref;
    },
    recall(ref: string): string | undefined {
      return stash.get(ref);
    },
  };
}

/** Format epoch-ms as a human timestamp (mirrors read-messages.ts). */
function fmtTs(ms: number): string {
  try {
    return formatAgentTimestamp(new Date(ms));
  } catch {
    return String(ms);
  }
}

/**
 * Resolve a self-sender SenderInfo from the session's provider+account.
 * Falls back to a generic sentinel when the account identity is not available.
 */
function resolveSelf(ctx: CrossChannelToolContext): SenderInfo {
  if (ctx.selfSender) return ctx.selfSender;
  const accountId = ctx.target.accountId;
  const self = accountId ? ctx.provider.getSelf(accountId) : undefined;
  if (self) return { id: self.id, username: self.username, displayName: self.displayName, isSelf: true };
  return { id: "mikuswarm", displayName: "Miku", isSelf: true };
}

/**
 * Send a message to `destTarget` (which may be any channel or DM the bot is in),
 * store cross_channel metadata, and ingest into the timeline.
 * Returns the result text or throws on provider error.
 */
async function sendWithCrossChannelNote(
  ctx: CrossChannelToolContext,
  destTarget: OutboundTarget,
  body: string,
  note: string,
): Promise<{ text: string; eventId: string | null }> {
  const destProvider = ctx.providers.get(destTarget.provider);
  if (!destProvider) {
    throw new Error(`Provider "${destTarget.provider}" is not registered.`);
  }
  const caps = destProvider.capabilities;
  const maxChars = caps.maxMessageChars ?? 4000;
  const chunks = chunkMarkdownText(body, maxChars);
  if (chunks.length === 0) chunks.push(body || "");

  const crossChannel: CanonicalChatEvent["crossChannel"] = {
    originTimelineKey: ctx.target.timelineKey,
    originSenderId: ctx.triggerSenderId,
    originSessionId: ctx.sessionId,
    note,
  };

  let lastEventId: string | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const receipt = await destProvider.send(destTarget, {
      body: chunks[i],
      agentSessionId: ctx.sessionId,
    });
    const event: CanonicalChatEvent = {
      id: `assistant:${ctx.sessionId}:${receipt.externalId ?? Date.now()}:${i}`,
      externalId: receipt.externalId,
      timelineKey: destTarget.timelineKey,
      provider: destProvider.id,
      agentSessionId: ctx.sessionId,
      agentSessionGeneration: ctx.agentSessionGeneration,
      role: "assistant",
      sender: resolveSelf(ctx),
      body: chunks[i],
      timestamp: receipt.deliveredAt,
      receivedAt: Date.now(),
      crossChannel: i === 0 ? crossChannel : undefined,
    };
    await ctx.timeline.ingestAssistantSend(event);
    lastEventId = receipt.externalId ?? null;
  }
  return {
    text: `sent: ${lastEventId ?? "local"}`,
    eventId: lastEventId,
  };
}

/**
 * Format a resolution-error candidate line (§5.1):
 * `  <id>  "<DisplayName>" (username) — shares <channels>; last seen <time>`
 */
function formatCandidate(c: {
  userId: string;
  username: string;
  displayName: string | null;
  lastSeen: number | null;
}): string {
  const name = c.displayName ? `"${c.displayName}" (${c.username})` : `"${c.username}"`;
  const seen = c.lastSeen ? `; last seen ${fmtTs(c.lastSeen)}` : "";
  return `  ${c.userId}  ${name}${seen}`;
}

// ── Tool factories ────────────────────────────────────────────────────────────

/** All five cross-channel tools, sharing a single session-scoped message stash. */
export function createCrossChannelTools(ctx: CrossChannelToolContext): AgentTool[] {
  const stash = makeMessageStash();
  return [
    createSendDmTool(ctx, stash),
    createSendToChannelTool(ctx, stash),
    createListMembersTool(ctx),
    createListChannelsTool(ctx),
    createDmOptoutTool(ctx),
  ];
}

// ── send_dm ───────────────────────────────────────────────────────────────────

function createSendDmTool(
  ctx: CrossChannelToolContext,
  stash: ReturnType<typeof makeMessageStash>,
): AgentTool {
  return {
    name: "send_dm",
    label: "Send DM",
    description:
      "Send a direct message to a user, opening the DM channel if needed (spec CROSS-CHANNEL-MESSAGING §4.1). " +
      "Requires the user's exact stable id (@user:server / snowflake / network/nick). " +
      "Use `list_members` with a `query` first when you only know a name. " +
      "A `context_note` is required: 1–2 sentences on why you're DMing and whether a reply should be relayed back.",
    parameters: Type.Object({
      user: Type.String({
        description:
          "Exact stable user id (@user:server for Matrix, snowflake for Discord, network/nick for IRC). " +
          "Any string is accepted; an inexact match returns resolution candidates instead of sending.",
      }),
      message: Type.Optional(Type.String({
        description: "Message body. Required unless message_ref is given.",
      })),
      message_ref: Type.Optional(Type.String({
        description:
          "Handle from a prior send_dm or send_to_channel resolution error (e.g. \"m1\"). " +
          "Re-sends the stashed body. `message` wins when both are given.",
      })),
      context_note: Type.String({
        description:
          "Required 1–2 sentence note: what prompted this DM and whether/where a reply should be relayed back. " +
          "Never sent to the recipient — stored locally as context for the DM session.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as {
        user: string;
        message?: string;
        message_ref?: string;
        context_note: string;
      };

      const userId = args.user.trim();
      if (!userId) {
        return { content: [{ type: "text", text: "error: `user` must not be empty." }], details: null };
      }

      // Master switch + DM initiation gate (§10).
      if (!ctx.messagingEnabled) {
        return {
          content: [{ type: "text", text: "error: cross-channel messaging is disabled in config ([messaging].enabled = false)." }],
          details: null,
        };
      }
      if (!ctx.dmInitiationEnabled) {
        return {
          content: [{ type: "text", text: "error: DM initiation is disabled in config ([messaging].dm_initiation = false)." }],
          details: null,
        };
      }

      // Resolve body from message / message_ref.
      let body: string | undefined = args.message?.trim();
      if (!body && args.message_ref) {
        body = stash.recall(args.message_ref.trim());
        if (!body) {
          return {
            content: [{
              type: "text",
              text: `error: message_ref "${args.message_ref}" not found in this session's stash. Either the session ended or the ref was mistyped.`,
            }],
            details: null,
          };
        }
      }
      if (!body) {
        return {
          content: [{ type: "text", text: "error: provide either `message` or a valid `message_ref`." }],
          details: null,
        };
      }

      // Opt-out check fires before resolution (§4.1, §7 enforcement point 1).
      // Exact-id check: does this userId have an opt-out?
      // We also run it after fuzzy resolution, but we check early for exact ids.
      const earlyOptout = ctx.storage.getDmOptout(ctx.target.provider, userId);
      if (earlyOptout) {
        const ref = stash.store(body);
        return {
          content: [{
            type: "text",
            text: buildOptoutError(userId, earlyOptout.createdAt, earlyOptout.originTimelineKey, ref),
          }],
          details: null,
        };
      }

      const accountId = ctx.target.accountId;
      if (!accountId) {
        return {
          content: [{ type: "text", text: "error: session has no accountId — cannot open a DM." }],
          details: null,
        };
      }

      // Fuzzy resolution check: if userId is NOT an exact match for this provider
      // (heuristic: Matrix MXIDs start with @, Discord snowflakes are numeric,
      // IRC scoped ids contain /), search the corpus.
      // This runs BEFORE the openDm capability check so that a fuzzy input
      // gets a resolution-error (with message_ref) regardless of whether the
      // provider supports openDm.
      const isExactId = isLikelyExactId(ctx.target.provider, userId);
      if (!isExactId) {
        const candidates = ctx.storage.searchUserIdentities(userId, {
          provider: ctx.target.provider,
          limit: 5,
        });
        if (candidates.length === 0) {
          const ref = stash.store(body);
          return {
            content: [{
              type: "text",
              text: `No user found matching "${userId}" in the identity corpus. ` +
                "They may not have posted in any channel this account has been in. " +
                `Use an exact stable id (@user:server / snowflake / network/nick) to address them directly ` +
                `(message_ref: "${ref}" re-sends your text without retyping it once you have the right id).`,
            }],
            details: null,
          };
        }
        const ref = stash.store(body);
        const lines = candidates.map(formatCandidate).join("\n");
        return {
          content: [{
            type: "text",
            text:
              `No exact user id match for "${userId}". Closest known users:\n${lines}\n` +
              `Re-send the same call with \`user\` set to one exact id (message_ref: "${ref}" re-sends your text without retyping it), ` +
              "or ask the requester which person they meant if genuinely ambiguous.",
          }],
          details: null,
        };
      }

      // Post-resolution opt-out check (catches fuzzy input that resolves uniquely
      // to a blocked user — in this branch we already have the exact id).
      const optout = ctx.storage.getDmOptout(ctx.target.provider, userId);
      if (optout) {
        const ref = stash.store(body);
        return {
          content: [{ type: "text", text: buildOptoutError(userId, optout.createdAt, optout.originTimelineKey, ref) }],
          details: null,
        };
      }

      // Check provider supports openDm (now that we have a confirmed exact id).
      if (!ctx.provider.openDm) {
        return {
          content: [{
            type: "text",
            text: `error: the "${ctx.target.provider}" provider does not support opening DMs from the agent.`,
          }],
          details: null,
        };
      }

      // Eligibility: user must share ≥1 visible channel with the sending account.
      // An existing DM timeline counts. We check by corpus presence (heuristic:
      // if they're in user_identities for this provider, they've been seen).
      const corpusEntry = ctx.storage.searchUserIdentities(userId, {
        provider: ctx.target.provider,
        limit: 1,
      }).find((r) => r.userId === userId);
      // If not in corpus, still allow exact-id sends (the operator configured this user)
      // but note the eligibility check passed — the spec says "users outside the corpus simply
      // never resolve by name" which we've already enforced above; exact-id allows the send.

      // Open DM channel.
      let dmResult: { timelineKey: string; status: "delivered" | "pending_invite" };
      try {
        dmResult = await ctx.provider.openDm(accountId, userId);
      } catch (err) {
        const ref = stash.store(body);
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text",
            text: `Failed to open DM with ${userId}: ${msg}\n(message_ref: "${ref}" to retry once the issue is resolved)`,
          }],
          details: null,
        };
      }

      // Visibility: sending into a DM is never isolation-blocked (§3.3 principle).
      // No visibility gate here — that principle is explicitly stated in the spec.

      // Build outbound target for the DM channel.
      const dmParsed = parseTimelineKey(dmResult.timelineKey);
      const dmTarget: OutboundTarget = {
        provider: ctx.target.provider,
        timelineKey: dmResult.timelineKey,
        accountId,
        roomId: dmParsed?.channelId,
      };

      // Send message with context note.
      let sendResult: { text: string; eventId: string | null };
      try {
        sendResult = await sendWithCrossChannelNote(ctx, dmTarget, body, args.context_note);
      } catch (err) {
        const ref = stash.store(body);
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text",
            text: `Failed to send DM to ${userId}: ${msg}\n(message_ref: "${ref}" to retry)`,
          }],
          details: null,
        };
      }

      const statusNote =
        dmResult.status === "pending_invite"
          ? " (DM channel created but they haven't accepted the invite yet — they may not see it until they do)"
          : "";

      return {
        content: [{
          type: "text",
          text: `${sendResult.text} to DM ${dmResult.timelineKey}${statusNote}`,
        }],
        details: {
          dm_timeline_key: dmResult.timelineKey,
          event_id: sendResult.eventId,
          status: dmResult.status,
        },
      };
    },
  };
}

// ── send_to_channel ───────────────────────────────────────────────────────────

function createSendToChannelTool(
  ctx: CrossChannelToolContext,
  stash: ReturnType<typeof makeMessageStash>,
): AgentTool {
  return {
    name: "send_to_channel",
    label: "Send to channel",
    description:
      "Send a message to another channel the bot is joined to (spec CROSS-CHANNEL-MESSAGING §4.2). " +
      "`channel` must be a full timeline key (use `list_channels` to enumerate joined channels). " +
      "A `context_note` is required: why this message is going there.",
    parameters: Type.Object({
      channel: Type.String({
        description:
          "Full timeline key of the destination channel (e.g. \"matrix:myaccount:room:!abc:example.org\"). " +
          "Unknown or unjoined channels return an error listing valid targets.",
      }),
      message: Type.Optional(Type.String({ description: "Message body. Required unless message_ref is given." })),
      message_ref: Type.Optional(Type.String({
        description: "Handle from a prior resolution error (e.g. \"m1\"). Re-sends stashed body.",
      })),
      context_note: Type.String({
        description:
          "Required 1–2 sentence note: what prompted this message and any relay expectations. " +
          "Stored locally on the event — not sent to the channel.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as {
        channel: string;
        message?: string;
        message_ref?: string;
        context_note: string;
      };

      const channelKey = args.channel.trim();

      if (!ctx.messagingEnabled) {
        return {
          content: [{ type: "text", text: "error: cross-channel messaging is disabled in config ([messaging].enabled = false)." }],
          details: null,
        };
      }

      // Resolve body.
      let body: string | undefined = args.message?.trim();
      if (!body && args.message_ref) {
        body = stash.recall(args.message_ref.trim());
        if (!body) {
          return {
            content: [{
              type: "text",
              text: `error: message_ref "${args.message_ref}" not found in this session's stash.`,
            }],
            details: null,
          };
        }
      }
      if (!body) {
        return {
          content: [{ type: "text", text: "error: provide either `message` or a valid `message_ref`." }],
          details: null,
        };
      }

      // Parse and validate the target timeline key.
      const parsed = parseTimelineKey(channelKey);
      if (!parsed) {
        const ref = stash.store(body);
        return {
          content: [{
            type: "text",
            text:
              `"${channelKey}" is not a valid timeline key. ` +
              `Use list_channels to see valid targets. (message_ref: "${ref}")`,
          }],
          details: null,
        };
      }

      // Find the provider for this channel.
      const destProvider = ctx.providers.get(parsed.provider);
      if (!destProvider) {
        const ref = stash.store(body);
        return {
          content: [{
            type: "text",
            text:
              `Provider "${parsed.provider}" is not registered. ` +
              `Use list_channels to see valid targets. (message_ref: "${ref}")`,
          }],
          details: null,
        };
      }

      // Visibility check: isolated channels can be sent INTO (§3.3) — but we
      // should not SUGGEST them in error paths. For a valid explicit timeline key,
      // send proceeds regardless of visibility mode.

      // Verify the account is joined by attempting to find the channel in the
      // provider's joined list (best-effort — providers that don't implement
      // listJoinedChannels skip this check).
      const accountId = parsed.accountId;
      if (destProvider.listJoinedChannels) {
        const joined = destProvider.listJoinedChannels(accountId, { includeDms: true });
        if (joined && !joined.some((k) => k === channelKey)) {
          // Build visible (non-isolated) channel suggestions.
          const visibleJoined = (joined ?? []).filter(
            (k) => ctx.visibilityResolver.modeFor(k) !== "isolated" || k === ctx.target.timelineKey,
          );
          const ref = stash.store(body);
          const suggestions = visibleJoined.slice(0, 8).map((k) => `  ${k}`).join("\n");
          return {
            content: [{
              type: "text",
              text:
                `The account is not currently joined to "${channelKey}". ` +
                `Valid channels include:\n${suggestions || "  (none visible)"}\n` +
                `(message_ref: "${ref}")`,
            }],
            details: null,
          };
        }
      }

      // Build destination target.
      const destTarget: OutboundTarget = {
        provider: parsed.provider,
        timelineKey: channelKey,
        accountId,
        roomId: parsed.channelId,
      };

      // Send with context note.
      let sendResult: { text: string; eventId: string | null };
      try {
        sendResult = await sendWithCrossChannelNote(ctx, destTarget, body, args.context_note);
      } catch (err) {
        const ref = stash.store(body);
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text",
            text: `Failed to send to ${channelKey}: ${msg}\n(message_ref: "${ref}")`,
          }],
          details: null,
        };
      }

      return {
        content: [{ type: "text", text: `${sendResult.text} to ${channelKey}` }],
        details: { event_id: sendResult.eventId },
      };
    },
  };
}

// ── list_members ──────────────────────────────────────────────────────────────

function createListMembersTool(ctx: CrossChannelToolContext): AgentTool {
  return {
    name: "list_members",
    label: "List members",
    description:
      "List channel members or search the identity corpus (spec CROSS-CHANNEL-MESSAGING §4.3). " +
      "Supports set operations (union / intersection / difference) across multiple rooms. " +
      "Use `query` for fuzzy name-to-id resolution before send_dm when you only know a display name.",
    parameters: Type.Object({
      rooms: Type.Optional(
        Type.Union([
          Type.Literal("current"),
          Type.Array(Type.String()),
          Type.Literal("all"),
        ], {
          description:
            "Which rooms to list. \"current\" (default) = current channel; " +
            "array of timeline keys = specific channels; " +
            "\"all\" requires a `query` (prevents huge dumps).",
        }),
      ),
      query: Type.Optional(Type.String({
        description:
          "Fuzzy search over display name, username, alias history, and user id across the identity corpus. " +
          "Required when rooms = \"all\".",
      })),
      op: Type.Optional(
        Type.Union([Type.Literal("union"), Type.Literal("intersection"), Type.Literal("difference")], {
          description:
            "Set operation when multiple rooms are given. Default: \"union\". " +
            "\"difference\" is ordered: members of the first room minus those in the rest.",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as {
        rooms?: "current" | string[] | "all";
        query?: string;
        op?: "union" | "intersection" | "difference";
      };
      const rooms = args.rooms ?? "current";
      const query = args.query?.trim();
      const op = args.op ?? "union";

      // "all" requires query.
      if (rooms === "all" && !query) {
        return {
          content: [{
            type: "text",
            text: 'error: rooms = "all" requires a `query` to avoid huge dumps. Provide a name or user id to search.',
          }],
          details: null,
        };
      }

      // Query-only mode: search the corpus.
      if (query && (rooms === "all" || rooms === "current")) {
        const provider = rooms === "current" ? ctx.target.provider : undefined;
        const hits = ctx.storage.searchUserIdentities(query, { provider, limit: 10 });
        if (hits.length === 0) {
          return {
            content: [{ type: "text", text: `No users matching "${query}" found in the identity corpus.` }],
            details: { count: 0, rows: [] },
          };
        }
        const lines = hits.map((h) => {
          const name = h.displayName ? `"${h.displayName}" (${h.username})` : `"${h.username}"`;
          const seen = h.lastSeen ? ` — last seen ${fmtTs(h.lastSeen)}` : "";
          return `  ${h.userId} [${h.provider}]  ${name}${seen}`;
        });
        return {
          content: [{ type: "text", text: `Found ${hits.length} user(s) matching "${query}":\n${lines.join("\n")}` }],
          details: { count: hits.length, rows: hits },
        };
      }

      // Resolve room list.
      const roomKeys: string[] = rooms === "current"
        ? [ctx.target.timelineKey]
        : (rooms === "all" ? [] : (rooms as string[]));

      // For each room, get members via the provider's channelClient.members().
      const roomMembers = new Map<string, SenderInfo[]>();
      const notes: string[] = [];

      for (const key of roomKeys) {
        // Visibility check: report isolated channels (reads blocked).
        const mode = ctx.visibilityResolver.modeFor(key);
        if (mode === "isolated" && key !== ctx.target.timelineKey) {
          notes.push(`  ${key}: isolated — cannot enumerate members from outside this channel.`);
          continue;
        }
        const parsed = parseTimelineKey(key);
        if (!parsed) {
          notes.push(`  ${key}: invalid timeline key.`);
          continue;
        }
        const provider = ctx.providers.get(parsed.provider);
        if (!provider) {
          notes.push(`  ${key}: provider "${parsed.provider}" not registered.`);
          continue;
        }
        const client = provider.channelClient({ provider: parsed.provider, timelineKey: key, accountId: parsed.accountId });
        if (!client?.members) {
          // Fall back to corpus if roster unavailable.
          notes.push(`  ${key}: roster unavailable (provider lacks membership_roster); using identity corpus only.`);
          const corpusHits = ctx.storage.searchUserIdentities(query ?? "", { provider: parsed.provider, limit: 50 });
          roomMembers.set(key, corpusHits.map((h) => ({ id: h.userId, username: h.username, displayName: h.displayName ?? undefined })));
          continue;
        }
        try {
          const members = await client.members();
          // Query filter.
          const filtered = query
            ? members.filter((m) =>
                [m.id, m.username, m.displayName].some((s) => s?.toLowerCase().includes(query.toLowerCase())),
              )
            : members;
          roomMembers.set(key, filtered);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          notes.push(`  ${key}: error fetching members: ${msg}`);
        }
      }

      // Set operations.
      let result: SenderInfo[];
      const roomMemberArrays = roomKeys.map((k) => roomMembers.get(k) ?? []);

      if (roomMemberArrays.length === 0) {
        result = [];
      } else if (roomMemberArrays.length === 1 || op === "union") {
        const seen = new Set<string>();
        result = [];
        for (const arr of roomMemberArrays) {
          for (const m of arr) {
            if (!seen.has(m.id)) { seen.add(m.id); result.push(m); }
          }
        }
      } else if (op === "intersection") {
        const sets = roomMemberArrays.map((arr) => new Set(arr.map((m) => m.id)));
        const first = roomMemberArrays[0];
        result = first.filter((m) => sets.every((s) => s.has(m.id)));
      } else {
        // difference: first room minus the rest.
        const otherIds = new Set(roomMemberArrays.slice(1).flat().map((m) => m.id));
        result = (roomMemberArrays[0] ?? []).filter((m) => !otherIds.has(m.id));
      }

      const lines = result.map((m) => {
        const label = m.displayName ? `"${m.displayName}" (${m.username ?? m.id})` : `"${m.username ?? m.id}"`;
        return `  ${m.id}  ${label}`;
      });
      const noteLines = notes.length > 0 ? `\n\nNotes:\n${notes.join("\n")}` : "";

      return {
        content: [{
          type: "text",
          text: result.length === 0
            ? `No members found (op: ${op}).${noteLines}`
            : `${result.length} member(s) (op: ${op}):\n${lines.join("\n")}${noteLines}`,
        }],
        details: {
          count: result.length,
          op,
          rooms: roomKeys,
          rows: result.map((m) => ({ id: m.id, username: m.username, displayName: m.displayName })),
        },
      };
    },
  };
}

// ── list_channels ─────────────────────────────────────────────────────────────

function createListChannelsTool(ctx: CrossChannelToolContext): AgentTool {
  return {
    name: "list_channels",
    label: "List channels",
    description:
      "Enumerate channels the bot's account(s) are joined to (spec CROSS-CHANNEL-MESSAGING §4.4). " +
      "Visibility-filtered: isolated channels not currently occupied by this session are omitted.",
    parameters: Type.Object({
      include_dms: Type.Optional(Type.Boolean({
        description: "When true, also list DM channels. Default: false.",
      })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { include_dms?: boolean };
      const includeDms = args.include_dms ?? false;

      const rows: Array<{ timelineKey: string; kind: string; provider: string; accountId: string }> = [];
      // Always include the current channel.
      const currentParsed = parseTimelineKey(ctx.target.timelineKey);

      for (const [, provider] of ctx.providers) {
        if (!provider.listJoinedChannels) continue;
        for (const accountId of provider.accountIds()) {
          const joined = provider.listJoinedChannels(accountId, { includeDms });
          if (!joined) continue;
          for (const key of joined) {
            const parsed = parseTimelineKey(key);
            if (!parsed) continue;
            // Filter DMs when not requested.
            if (parsed.kind === "dm" && !includeDms) continue;
            // Visibility gate: isolated channels outside the current session are omitted.
            const mode = ctx.visibilityResolver.modeFor(key);
            if (mode === "isolated" && key !== ctx.target.timelineKey) continue;
            rows.push({
              timelineKey: key,
              kind: parsed.kind,
              provider: parsed.provider,
              accountId: parsed.accountId,
            });
          }
        }
      }

      // Always include the current channel if not already listed.
      if (!rows.some((r) => r.timelineKey === ctx.target.timelineKey) && currentParsed) {
        rows.unshift({
          timelineKey: ctx.target.timelineKey,
          kind: currentParsed.kind,
          provider: currentParsed.provider,
          accountId: currentParsed.accountId,
        });
      }

      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: "No channels found." }],
          details: { count: 0, rows: [] },
        };
      }

      const lines = rows.map((r) => {
        const tag = r.kind === "dm" ? " [DM]" : "";
        return `  ${r.timelineKey}${tag}`;
      });
      return {
        content: [{ type: "text", text: `${rows.length} channel(s):\n${lines.join("\n")}` }],
        details: { count: rows.length, rows },
      };
    },
  };
}

// ── dm_optout ─────────────────────────────────────────────────────────────────

function createDmOptoutTool(ctx: CrossChannelToolContext): AgentTool {
  return {
    name: "dm_optout",
    label: "DM opt-out",
    description:
      "Let a user opt out of (or back in to) unprompted DMs from the agent (spec CROSS-CHANNEL-MESSAGING §4.5, §7). " +
      "Authorization is structural: only someone who addressed this session can flip their own bit. " +
      "Opt-out blocks agent-initiated DMs only; user-initiated DM sessions are unaffected.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("opt_out"), Type.Literal("opt_in")], {
        description: "\"opt_out\": block agent-initiated DMs. \"opt_in\": allow them again.",
      }),
      user: Type.Optional(Type.String({
        description:
          "The user to opt in/out. Default: the session's trigger sender. " +
          "When given, must match the trigger sender's id — others are rejected with an explanation.",
      })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { action: "opt_out" | "opt_in"; user?: string };

      // Resolve target user.
      const targetUserId = args.user?.trim() || ctx.triggerSenderId;

      // Structural authorization: only the trigger sender can flip their own bit.
      if (targetUserId !== ctx.triggerSenderId) {
        return {
          content: [{
            type: "text",
            text:
              `Only ${ctx.triggerSenderId} can opt themselves ${args.action === "opt_out" ? "out" : "in"} — ` +
              "they need to ask me directly. Tell the requester that this person needs to make this request themselves " +
              "(in any channel or in a DM with me).",
          }],
          details: null,
        };
      }

      if (args.action === "opt_out") {
        await ctx.storage.setDmOptout({
          provider: ctx.target.provider,
          userId: targetUserId,
          createdAt: Date.now(),
          originTimelineKey: ctx.target.timelineKey,
          originSessionId: ctx.sessionId,
        });
        return {
          content: [{
            type: "text",
            text:
              `Done — ${targetUserId} will no longer receive unprompted DMs from me. ` +
              "They can reverse this at any time by asking me (in any channel or in a DM) to allow DMs again.",
          }],
          details: { action: "opt_out", userId: targetUserId, provider: ctx.target.provider },
        };
      } else {
        await ctx.storage.clearDmOptout(ctx.target.provider, targetUserId);
        return {
          content: [{
            type: "text",
            text: `Done — ${targetUserId} will now receive DMs from me again.`,
          }],
          details: { action: "opt_in", userId: targetUserId, provider: ctx.target.provider },
        };
      }
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the opt-out rejection error string (§5.4).
 */
function buildOptoutError(
  userId: string,
  createdAt: number,
  originTimelineKey: string | null,
  messageRef: string,
): string {
  const where = originTimelineKey ? ` in ${originTimelineKey}` : "";
  const when = fmtTs(createdAt);
  return (
    `${userId} opted out of unprompted DMs (requested ${when}${where}). ` +
    "Do not DM them. Tell the requester they have asked not to be DMed. " +
    `They can reverse this themselves by asking me — in any channel or by DMing me — to allow DMs again (dm_optout, action "opt_in"). ` +
    `(message_ref: "${messageRef}" holds your message in case they opt back in)`
  );
}

/**
 * Heuristic: does `userId` look like an exact stable id for this provider?
 * Used to decide whether to trigger fuzzy resolution (§5.1) or proceed directly.
 *
 * Matrix: MXIDs start with @
 * Discord: pure numeric snowflakes
 * IRC: scoped ids contain /
 *
 * This is a best-effort check — the spec says "Any string accepted; inexact
 * input → resolution error, never a guess." So when in doubt, we proceed and
 * let the provider's own send fail with a clear message.
 */
function isLikelyExactId(provider: string, userId: string): boolean {
  if (provider === "matrix") return userId.startsWith("@");
  if (provider === "discord") return /^\d{15,20}$/.test(userId);
  if (provider === "irc") return userId.includes("/");
  // Unknown provider: treat any non-empty string as possibly exact.
  return true;
}
