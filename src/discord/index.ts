/**
 * Discord provider — public exports (Phase 7a).
 *
 * Phase 7b will add: DiscordChannelClient, emoji catalog, history client,
 * reaction handlers, voice-message send, set_profile, identity upserts.
 */

export { DiscordProvider, type DiscordProviderCallbacks, resolveMentionTokens } from "./provider.js";
export {
  buildDiscordTimelineKey,
  buildDiscordEventId,
  translateDiscordMarkup,
  normalizeDiscordMessage,
  detectDiscordTrigger,
  embedsToLinkPreviews,
  extractEmojiObservations,
  type DiscordMessageData,
  type DiscordNormalizerContext,
  type DiscordMentionedUser,
  type DiscordMentionedRole,
  type DiscordMentionedChannel,
  type DiscordAttachmentData,
  type DiscordStickerData,
  type DiscordEmbedData,
  type DiscordReferencedMessage,
  type DiscordNormalizeResult,
} from "./normalizer.js";
