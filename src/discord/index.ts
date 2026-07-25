/**
 * Discord provider — public exports.
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
export { EmojiCatalog, type CatalogEmojiInfo } from "./emoji-catalog.js";
export { DiscordChannelClient } from "./channel-client.js";
export { DiscordHistoryClient } from "./history-client.js";
export {
  encodeVoiceMessage,
  computeWaveform,
  computeWaveformBase64,
  cleanupVoiceFile,
  voiceFileExists,
  WAVEFORM_SAMPLE_COUNT,
  type VoiceMessageEncodeResult,
} from "./voice-message.js";
