/**
 * Type guard for Node.js system errors (ENOENT, EACCES, etc.).
 * Checks that the value is an Error with a `code` property.
 */
export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export type ChatRole = "user" | "assistant";

/**
 * Lifecycle state of a timeline (chat channel / DM). A timeline is `inactive`
 * until someone first triggers the bot in it; activation runs through
 * `activating` (first-trigger backfill + enrichment) to `active`. `backfilling`
 * is reserved for operator-initiated bulk history fetching (deferred). A
 * timeline with no `timeline_compaction_state` row is implicitly `inactive`.
 */
export type TimelineState = "inactive" | "activating" | "active" | "backfilling";

export interface SenderInfo {
  id: string;
  displayName?: string;
  isSelf?: boolean;
}

export interface CaptionResult {
  attachmentId: string;
  text: string;
  model?: string;
  generatedAt: number;
  status: "pending" | "complete" | "failed";
  error?: string;
}

export interface AttachmentMeta {
  id: string;
  filename?: string;
  mimeType?: string;
  mediaType: "image" | "video" | "audio" | "file";
  sizeBytes?: number;
  width?: number;
  height?: number;
  localPath?: string;
  remoteUrl?: string;
  caption?: string;
  asVoice?: boolean;
  durationMs?: number;
  isCharacterCard?: boolean;
  cardName?: string;
  isImageBlock?: boolean;
  processing?: {
    downloaded?: boolean;
    captioned?: boolean;
    error?: string;
  };
}

export interface ReplyContext {
  externalId?: string;
  sender?: SenderInfo;
  body?: string;
  htmlBody?: string;
  timestamp?: number;
  attachments?: AttachmentMeta[];
  linkedMedia?: AttachmentMeta[];
  linkPreviews?: LinkPreviewMeta[];
}

export interface LinkPreviewMeta {
  url: string;
  title?: string;
  description?: string;
  media?: AttachmentMeta[];
  sourceKind?: string;
  fetchedAt?: number;
}

export interface MentionInfo {
  mentionedUserIds: string[];
  mentionedSelf?: boolean;
}

export interface ReactionInfo {
  key: string;
  sender: SenderInfo;
  timestamp: number;
}

export interface TriggerInfo {
  type: "mention" | "dm" | "timer" | "manual" | "reply";
  reason: string;
  triggeredBy: SenderInfo;
  holdStartedAt?: number;
  holdEndedAt?: number;
  groupedEventIds?: string[];
}

export interface CanonicalChatEvent {
  id: string;
  externalId?: string;
  timelineKey: string;
  provider: string;
  agentSessionId?: string;
  role: ChatRole;
  sender: SenderInfo;
  body: string;
  htmlBody?: string;
  timestamp: number;
  receivedAt: number;
  attachments?: AttachmentMeta[];
  linkedMedia?: AttachmentMeta[];
  replyTo?: ReplyContext;
  linkPreviews?: LinkPreviewMeta[];
  mentions?: MentionInfo;
  reactions?: ReactionInfo[];
  threadId?: string;
  trigger?: TriggerInfo;
  generatedCaptions?: CaptionResult[];
  /**
   * Set when this event could not be decrypted (UTD). The renderer keys off this
   * field — not the body — to show a human-client-style "unable to decrypt"
   * placeholder, so `body` stays empty and never leaks. Cleared by the
   * re-decryption sweeper when the real event is recovered, at which point
   * `body`/`attachments` carry the decrypted content.
   */
  undecryptable?: { sessionId?: string; reason?: string };
}

export interface InboundChatEvent {
  provider: string;
  timelineKey: string;
  event: CanonicalChatEvent;
  trigger?: TriggerInfo;
  outboundTarget?: OutboundTarget;
  /**
   * Set when this inbound event is a message edit (`m.replace`). `event` carries
   * the replacement body/attachments (from `m.new_content`); `targetExternalId`
   * is the provider event id of the message being edited. The pipeline applies
   * the replacement to that target in place instead of appending a new timeline
   * row, mirroring how a normal client shows an edited message (issue #17).
   */
  edit?: { targetExternalId: string };
}

export interface OutboundTarget {
  provider: string;
  timelineKey: string;
  accountId?: string;
  roomId?: string;
  threadId?: string;
  replyToId?: string;
}

export interface OutboundMessage {
  body: string;
  htmlBody?: string;
  attachments?: AttachmentMeta[];
  agentSessionId?: string;
}

export interface DeliveryReceipt {
  provider: string;
  target: OutboundTarget;
  externalId?: string;
  externalIds?: string[];
  deliveredAt: number;
}

export type Unsubscribe = () => void;

export interface ProviderCapabilities {
  typing?: boolean;
  reactions?: boolean;
  readReceipts?: boolean;
  mediaUpload?: boolean;
}

export interface ChatProvider<ProviderConfig = unknown> {
  readonly id: string;
  capabilities: ProviderCapabilities;
  start(config: ProviderConfig): Promise<void>;
  stop(): Promise<void>;
  subscribe(handler: (event: InboundChatEvent) => void): Unsubscribe;
  send(target: OutboundTarget, message: OutboundMessage): Promise<DeliveryReceipt>;
  setTyping(target: OutboundTarget, typing: boolean): Promise<void>;
}
