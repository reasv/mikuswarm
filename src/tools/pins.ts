import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChannelClient, ProviderTerminology } from "../types.js";
import { MATRIX_TERMINOLOGY } from "./terminology.js";
import { formatAgentTimestamp } from "../time/index.js";

export interface PinsToolContext {
  channelClient: ChannelClient;
  terminology?: ProviderTerminology;
  /** Bound on the pin-list read of the no-op check (default {@link PIN_STATE_TIMEOUT_MS}). */
  stateTimeoutMs?: number;
}

export function createPinsTool(context: PinsToolContext): AgentTool {
  const t = context.terminology ?? MATRIX_TERMINOLOGY;
  return {
    name: "pins",
    label: "Pin management",
    // Resume work gate (spec RESUMABLE-SESSIONS §7a): chat-surface — not work.
    resumeWorkExempt: true,
    description: `Pin, unpin, or list pinned messages in the current ${t.channelNoun}. Pinning/unpinning requires sufficient ${t.channelNoun} permissions.`,
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("pin"),
        Type.Literal("unpin"),
        Type.Literal("list"),
      ], { description: "Action to perform: pin a message, unpin a message, or list all pinned messages." }),
      message_id: Type.Optional(Type.String({ description: `${t.messageIdFmt}. Required for pin/unpin actions.` })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { action: "pin" | "unpin" | "list"; message_id?: string };

      if ((args.action === "pin" || args.action === "unpin") && !args.message_id?.trim()) {
        return {
          content: [{ type: "text", text: `error: message_id is required for ${args.action} action.` }],
          details: null,
        };
      }

      try {
        if (args.action === "list") {
          const pins = await context.channelClient.pins();
          if (pins.length === 0) {
            return {
              content: [{ type: "text", text: `No pinned messages in this ${t.channelNoun}.` }],
              details: { events: [] },
            };
          }
          const lines = pins.map((p) => {
            const name = p.sender.displayName ?? p.sender.id;
            const body = p.body.length > 100 ? p.body.slice(0, 100) + "…" : p.body;
            let time: string;
            try {
              time = formatAgentTimestamp(new Date(p.timestamp));
            } catch {
              time = String(p.timestamp);
            }
            return `[${p.externalId}] ${name}: ${body} (${time})`;
          });
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { count: pins.length },
          };
        }

        // Already in the requested state: the call is a no-op, which late input
        // must not "undo" (unpinning a pin that existed before, §8 "Late input").
        const unchanged = await alreadyInState(context.channelClient, args.message_id!.trim(), args.action, context.stateTimeoutMs ?? PIN_STATE_TIMEOUT_MS);
        if (args.action === "pin") {
          const result = await context.channelClient.pinMessage(args.message_id!.trim());
          const pinCount = (result as { pinCount?: number } | null | void)?.pinCount;
          const suffix = pinCount != null ? ` ${pinCount} total pins.` : "";
          return {
            content: [{ type: "text", text: `pinned message.${suffix}` }],
            details: unchanged ? { changed: false } : null,
          };
        }

        const result = await context.channelClient.unpinMessage(args.message_id!.trim());
        const pinCount = (result as { pinCount?: number } | null | void)?.pinCount;
        const suffix = pinCount != null ? ` ${pinCount} total pins.` : "";
        return {
          content: [{ type: "text", text: `unpinned message.${suffix}` }],
          details: unchanged ? { changed: false } : null,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `error: ${args.action} failed: ${message}` }],
          details: null,
        };
      }
    },
  };
}

/** How long the no-op check waits for the pin list before treating the state as unknown. */
export const PIN_STATE_TIMEOUT_MS = 3000;

/**
 * True only when the message is known to be pinned already (a pin is a no-op);
 * false when unknown. The pin list can be incomplete (a provider returns at
 * most a page of pins, or omits a pinned message it cannot fetch), so a
 * message missing from it is never proof that it is not pinned: an unpin is
 * always taken as a change, which late input may compensate.
 */
async function alreadyInState(client: ChannelClient, messageId: string, action: "pin" | "unpin", timeoutMs: number): Promise<boolean> {
  if (action !== "pin") return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
      timer.unref?.();
    });
    const pins = await Promise.race([client.pins(), timeout]);
    return pins?.some((p) => p.externalId === messageId) ?? false;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
