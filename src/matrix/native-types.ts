export type MatrixThreadRepliesMode = "off" | "inbound" | "always";
export type MatrixReplyToMode = "off" | "first" | "all";
export type MatrixSyncState = "stopped" | "starting" | "ready" | "error";
export type MatrixVerificationState = "disabled" | "pending" | "verified";
export type MatrixKeyBackupState = "disabled" | "pending" | "enabled";
export type MatrixChatType = "direct" | "channel" | "thread";
export type MatrixMediaKind = "image" | "video" | "audio" | "file";
export type MatrixLinkPreviewSourceKind = "synapse" | "fx_twitter";

export type MatrixNativeConfig = {
  accountId: string;
  homeserver: string;
  userId: string;
  auth:
    | { mode: "password"; password: string }
    | { mode: "accessToken"; accessToken: string };
  recoveryKey?: string;
  deviceName?: string;
  initialSyncLimit: number;
  encryptionEnabled: boolean;
  defaultThreadReplies: MatrixThreadRepliesMode;
  replyToMode: MatrixReplyToMode;
  stateLayout: {
    rootDir: string;
    sessionFile: string;
    sdkStoreDir: string;
    cryptoStoreDir: string;
    mediaCacheDir: string;
    emojiCatalogFile: string;
    reactionsFile: string;
    logsDir: string;
  };
  roomOverrides: Record<
    string,
    {
      threadReplies?: MatrixThreadRepliesMode;
      requireMention?: boolean;
    }
  >;
};

export type MatrixNativeLifecycleStage =
  | "load_session"
  | "init_stores"
  | "restore_or_login"
  | "persist_session"
  | "init_crypto"
  | "restore_recovery"
  | "enable_backup"
  | "start_sync";

export type MatrixNativeEvent =
  | {
      type: "lifecycle";
      stage: MatrixNativeLifecycleStage;
      detail: string;
      at: string;
    }
  | {
      type: "sync_state";
      state: MatrixSyncState;
      at: string;
    }
  | {
      type: "outbound";
      roomId: string;
      messageId: string;
      threadId?: string;
      replyToId?: string;
      at: string;
    }
  | {
      type: "inbound";
      event: MatrixInboundEvent;
    };

export type MatrixNativeDiagnostics = {
  accountId: string;
  userId: string;
  deviceId: string;
  verificationState: MatrixVerificationState;
  keyBackupState: MatrixKeyBackupState;
  syncState: MatrixSyncState;
  lastSuccessfulSyncAt: string | null;
  lastSuccessfulDecryptionAt: string | null;
  startedAt: string | null;
};

export type MatrixSendRequest = {
  roomId: string;
  text: string;
  html?: string;
  replyToId?: string;
  threadId?: string;
};

export type MatrixSendResult = {
  roomId: string;
  messageId: string;
  threadId?: string;
};

export type MatrixTypingRequest = {
  roomId: string;
  typing: boolean;
};

export type MatrixResolveTargetRequest = {
  target: string;
  createDm?: boolean;
};

export type MatrixResolveTargetResult = {
  input: string;
  resolvedRoomId: string;
  canonicalTarget: string;
  isDirect: boolean;
  roomAlias?: string;
};

export type MatrixJoinRequest = {
  target: string;
};

export type MatrixJoinResult = {
  roomId: string;
  joined: boolean;
};

export type MatrixInboundMedia = {
  index: number;
  kind: MatrixMediaKind;
  body?: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
};

export type MatrixInboundMentions = {
  userIds?: string[];
  room?: boolean;
};

export type MatrixInboundEvent = {
  roomId: string;
  eventId: string;
  senderId: string;
  senderName?: string;
  roomName?: string;
  roomAlias?: string;
  chatType: MatrixChatType;
  body: string;
  msgtype?: string;
  formattedBody?: string;
  mentions?: MatrixInboundMentions;
  replyToId?: string;
  threadRootId?: string;
  /**
   * Relation metadata for this event. For an `m.replace` edit this is
   * `{ relType: "m.replace", eventId: <target> }` — the id of the message this
   * event edits — and `body`/`media` already hold the replacement
   * (`m.new_content`), not the `*` fallback. Absent for non-relating messages;
   * reply/thread relations are surfaced via `replyToId`/`threadRootId` instead.
   */
  relatesTo?: MatrixMessageRelatesTo;
  timestamp: string;
  media: MatrixInboundMedia[];
  /**
   * `true` when this event could not be decrypted (UTD). `body`/`media` are
   * empty; the TS renderer shows a human-client-style placeholder. Never set for
   * a normal decrypted event.
   */
  undecryptable?: boolean;
  /** Megolm session id whose key is missing, when known. Diagnostic only. */
  sessionId?: string;
  /**
   * Stable lowercase code for *why* decryption failed, when known (mapped from
   * the SDK `UnableToDecryptReason`). Always absent on the live path. Diagnostic
   * only.
   */
  utdReason?: string;
};

export type MatrixMessageRelatesTo = {
  relType?: string;
  eventId?: string;
};

export type MatrixMessageSummary = {
  eventId: string;
  sender: string;
  senderName?: string;
  body: string;
  msgtype?: string;
  timestamp: string;
  relatesTo?: MatrixMessageRelatesTo;
  /**
   * Media descriptors carried by backfilled/summarized events, mirroring the
   * live {@link MatrixInboundEvent.media}. Optional for backward-compat with the
   * Rust `#[serde(default)]` (older payloads / other summary producers omit it).
   */
  media?: MatrixInboundMedia[];
  /**
   * `true` when the summarized event could not be decrypted (UTD). Re-fetching
   * the same event id once room keys arrive returns a non-UTD summary — the
   * signal the re-decryption sweeper uses to detect success.
   */
  undecryptable?: boolean;
  /** Megolm session id whose key is missing, when known. Diagnostic only. */
  sessionId?: string;
  /**
   * Stable lowercase code for *why* decryption failed, when known, mapped from
   * the SDK `UnableToDecryptReason` (e.g. `missing_megolm_session`,
   * `unknown_megolm_message_index`, `malformed_encrypted_event`). Diagnostic
   * only.
   */
  utdReason?: string;
};

export type MatrixMessageSummaryRequest = {
  roomId: string;
  eventId: string;
};

export type MatrixReadMessagesRequest = {
  roomId: string;
  limit?: number;
  before?: string;
  after?: string;
};

export type MatrixReadMessagesResult = {
  messages: MatrixMessageSummary[];
  nextBatch?: string | null;
  prevBatch?: string | null;
};

export type MatrixEditMessageRequest = {
  roomId: string;
  messageId: string;
  text: string;
};

export type MatrixEditMessageResult = {
  roomId: string;
  messageId: string;
  eventId: string;
};

export type MatrixDeleteMessageRequest = {
  roomId: string;
  messageId: string;
  reason?: string;
};

export type MatrixDeleteMessageResult = {
  roomId: string;
  messageId: string;
  eventId: string;
};

export type MatrixMemberInfoRequest = {
  roomId: string;
  userId: string;
};

export type MatrixMemberInfo = {
  roomId: string;
  userId: string;
  displayName?: string;
  avatarUrl?: string;
  membership?: string;
  isSelf: boolean;
  isDirect: boolean;
};

export type MatrixChannelInfoRequest = {
  roomId: string;
};

export type MatrixChannelInfo = {
  roomId: string;
  displayName?: string;
  canonicalAlias?: string;
  altAliases: string[];
  joined: boolean;
  isDirect: boolean;
  memberCount?: number;
  // Display name (or canonical alias) of the room's single legitimate parent
  // space, when one exists (ARCHITECTURE.md §9c). Used to build the diary header's
  // `<ROOM>` label as `Room Name (Space Name)`. Absent when the room has no
  // spec-legitimate, name-resolvable parent space.
  parentSpaceName?: string;
};

export type MatrixUploadMediaThumbnail = {
  dataBase64: string;
  contentType: string;
  width: number;
  height: number;
  sizeBytes: number;
};

export type MatrixUploadMediaRequest = {
  roomId: string;
  filename: string;
  contentType: string;
  dataBase64: string;
  thumbnail?: MatrixUploadMediaThumbnail;
  caption?: string;
  replyToId?: string;
  threadId?: string;
  asVoice?: boolean;
  durationMs?: number;
};

export type MatrixUploadMediaResult = {
  roomId: string;
  messageId: string;
  filename: string;
  contentType: string;
};

export type MatrixDownloadMediaRequest = {
  roomId: string;
  eventId: string;
  outputPath: string;
  sizeLimit?: number;
};

export type MatrixDownloadMediaResult = {
  roomId: string;
  eventId: string;
  kind: MatrixMediaKind;
  body?: string;
  filename?: string;
  contentType?: string;
  sizeBytes: number;
};

export type MatrixLinkPreviewSource = {
  url: string;
  sourceKind: MatrixLinkPreviewSourceKind;
  siteName?: string;
  title?: string;
  description?: string;
};

export type MatrixLinkPreviewMedia = {
  sourceUrl: string;
  filename?: string;
  contentType?: string;
  dataBase64: string;
};

export type MatrixResolveLinkPreviewsRequest = {
  bodyText: string;
  maxBytes?: number;
  includeImages?: boolean;
  xPreviewViaFxTwitter?: boolean;
};

export type MatrixLinkPreviewResult = {
  textBlocks: string[];
  media: MatrixLinkPreviewMedia[];
  sources: MatrixLinkPreviewSource[];
};

export type MatrixReactionKind = "unicode" | "custom" | "text";

export type MatrixReactionInfo = {
  raw: string;
  normalized: string;
  display: string;
  kind: MatrixReactionKind;
  shortcode?: string;
};

export type MatrixReactionSummary = {
  key: string;
  normalizedKey: string;
  display: string;
  kind: MatrixReactionKind;
  shortcode?: string;
  count: number;
  users: string[];
  rawKeys: string[];
};

export type MatrixReactRequest = {
  roomId: string;
  messageId: string;
  key: string;
  remove?: boolean;
  senderId?: string;
};

export type MatrixReactResult = {
  removed: number;
  reaction?: MatrixReactionInfo | null;
};

export type MatrixEmojiUsageRef = {
  shortcode: string;
  mxcUrl: string;
};

export type MatrixEmojiUsageRequest = {
  emoji: MatrixEmojiUsageRef[];
  roomId?: string;
  observedAtMs?: number;
};

export type MatrixListReactionsRequest = {
  roomId: string;
  messageId: string;
  limit?: number;
};

export type MatrixPinMessageRequest = {
  roomId: string;
  messageId: string;
};

export type MatrixListPinsRequest = {
  roomId: string;
};

export type MatrixPinsResult = {
  roomId: string;
  pinned: string[];
  events: MatrixMessageSummary[];
};

export type MatrixListEmojiRequest = {
  roomId?: string;
  limit?: number;
  nowMs?: number;
};

export type MatrixSetProfileRequest = {
  displayName?: string;
  avatarUrl?: string;
  avatarDataBase64?: string;
  avatarContentType?: string;
};

export type MatrixSetProfileResult = {
  displayName?: string;
  avatarUrl?: string;
};

export type MatrixPollAnswer = {
  id: string;
  text: string;
};

export type MatrixCreatePollRequest = {
  roomId: string;
  question: string;
  answers: MatrixPollAnswer[];
  maxSelections?: number;
  replyToId?: string;
  threadId?: string;
};

export type MatrixCreatePollResult = {
  roomId: string;
  eventId: string;
};

export type MatrixPollVoteRequest = {
  roomId: string;
  pollEventId: string;
  answerIds: string[];
};

export type MatrixPollVoteResult = {
  roomId: string;
  eventId: string;
};
