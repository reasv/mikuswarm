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
  senderIdHint: "for example a Matrix mxid",
  // Pre-Phase-8 spawn_session strings — byte-for-byte reproduction so Matrix
  // model vocabulary is unchanged.
  coReplyIdDescription:
    "The Matrix event id ($…) of the co-reply message to spin off, as given in the co-reply interjection.",
  coReplyIdRequiredError:
    "error: message_id is required (the $… event id from the co-reply interjection).",
};

/**
 * Discord terminology bundle.
 * Selected by `buildSessionTools` for any session whose `target.provider` is `"discord"`.
 * All description strings are Discord-native equivalents of the Matrix ones.
 */
export const DISCORD_TERMINOLOGY: ProviderTerminology = {
  messageIdFmt: "Discord message ID",
  userIdFmt: "Discord user ID (snowflake)",
  channelNoun: "channel",
  providerName: "Discord",
  mentionNote:
    "An exact @username match against known channel participants is resolved to a real mention — no special markup needed.",
  senderIdHint: "for example a Discord user ID snowflake",
  // Discord-native spawn_session strings.
  coReplyIdDescription:
    "The message id of the co-reply message to spin off, as given in the co-reply interjection.",
  coReplyIdRequiredError:
    "error: message_id is required (the message id from the co-reply interjection).",
};

/**
 * IRC terminology bundle (spec IRC-SUPPORT-DESIGN §10).
 * Selected by `buildSessionTools` for any session whose `target.provider` is `"irc"`.
 * IRC mentions work by bare-nick word-boundary occurrence — no markup exists.
 */
export const IRC_TERMINOLOGY: ProviderTerminology = {
  messageIdFmt: "message ID",
  userIdFmt: "IRC nick or services account",
  channelNoun: "channel",
  providerName: "IRC",
  mentionNote:
    "A bare nick occurring anywhere in the message text is treated as a mention by IRC clients — no special markup exists or is needed.",
  senderIdHint: "for example an IRC nick or services account name",
  // IRC-native spawn_session strings.
  coReplyIdDescription:
    "The message id of the co-reply message to spin off, as given in the co-reply interjection.",
  coReplyIdRequiredError:
    "error: message_id is required (the message id from the co-reply interjection).",
};
