export type ChatRole = "user" | "assistant";

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
}

export interface InboundChatEvent {
  provider: string;
  timelineKey: string;
  event: CanonicalChatEvent;
  trigger?: TriggerInfo;
  outboundTarget?: OutboundTarget;
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
