/**
 * Provider-aware terminology bundles for tool schema descriptions
 * (spec DISCORD-SUPPORT-DESIGN §7.1).
 *
 * Each provider exports a bundle whose values, when substituted into the tool
 * description templates, reproduce the exact provider-native strings. The Matrix
 * bundle reproduces today's strings byte-for-byte.
 */
import type { ProviderTerminology } from "../types.js";

/**
 * Matrix terminology bundle.
 *
 * When used in tool schemas, the resulting description strings are byte-identical
 * to the strings that existed before Phase 4 (the ones the model has always seen
 * in Matrix sessions).
 */
export const MATRIX_TERMINOLOGY: ProviderTerminology = {
  messageIdFmt: "Matrix event ID",
  userIdFmt: "Matrix user ID (e.g. @user:server.com)",
  channelNoun: "room",
  providerName: "Matrix",
  mentionNote:
    "An exact Matrix user ID like @name:server in the text is turned into a real mention automatically (pill + notification) — no special markup needed.",
};

/**
 * Discord terminology bundle (Phase 7 — not yet in use).
 * Defined here so the bundle shape is validated at compile time
 * and so the Discord provider can import it without changes in Phase 7.
 */
export const DISCORD_TERMINOLOGY: ProviderTerminology = {
  messageIdFmt: "Discord message ID",
  userIdFmt: "Discord user ID (snowflake)",
  channelNoun: "channel",
  providerName: "Discord",
  mentionNote:
    "An exact @username match against known channel participants is resolved to a real mention — no special markup needed.",
};
