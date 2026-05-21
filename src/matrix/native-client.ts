import { NativeMatrixCoreClient } from "./native-binding.js";
import type {
  MatrixChannelInfo,
  MatrixChannelInfoRequest,
  MatrixDeleteMessageRequest,
  MatrixDeleteMessageResult,
  MatrixDownloadMediaRequest,
  MatrixDownloadMediaResult,
  MatrixEditMessageRequest,
  MatrixEditMessageResult,
  MatrixEmojiUsageRequest,
  MatrixJoinRequest,
  MatrixJoinResult,
  MatrixLinkPreviewResult,
  MatrixListEmojiRequest,
  MatrixListPinsRequest,
  MatrixListReactionsRequest,
  MatrixMemberInfo,
  MatrixMemberInfoRequest,
  MatrixMessageSummary,
  MatrixMessageSummaryRequest,
  MatrixNativeConfig,
  MatrixNativeDiagnostics,
  MatrixNativeEvent,
  MatrixPinsResult,
  MatrixPinMessageRequest,
  MatrixReactRequest,
  MatrixReactResult,
  MatrixReactionSummary,
  MatrixReadMessagesRequest,
  MatrixReadMessagesResult,
  MatrixResolveLinkPreviewsRequest,
  MatrixResolveTargetRequest,
  MatrixResolveTargetResult,
  MatrixSendRequest,
  MatrixSendResult,
  MatrixTypingRequest,
  MatrixUploadMediaRequest,
  MatrixUploadMediaResult,
} from "./native-types.js";
import { decodeNativeDiagnostics, decodeNativeEvents, decodeSendResult } from "./events.js";

type NativeBindingClient = {
  start(configJson: string): string;
  stop(): void;
  pollEvents(): string;
  diagnostics(): string;
  sendMessage(requestJson: string): string;
  resolveTarget(requestJson: string): string;
  joinRoom(requestJson: string): string;
  readMessages(requestJson: string): string;
  messageSummary(requestJson: string): string;
  editMessage(requestJson: string): string;
  deleteMessage(requestJson: string): string;
  pinMessage(requestJson: string): string;
  unpinMessage(requestJson: string): string;
  listPins(requestJson: string): string;
  memberInfo(requestJson: string): string;
  channelInfo(requestJson: string): string;
  uploadMedia(requestJson: string): string;
  downloadMedia(requestJson: string): string;
  reactMessage(requestJson: string): string;
  listReactions(requestJson: string): string;
  recordCustomEmojiUsage(requestJson: string): void;
  listKnownShortcodes(requestJson: string): string;
  resolveLinkPreviews(requestJson: string): string;
  setTyping(requestJson: string): void;
};

export class MatrixNativeClient {
  readonly #client: NativeBindingClient;

  constructor() {
    this.#client = new NativeMatrixCoreClient() as unknown as NativeBindingClient;
  }

  start(config: MatrixNativeConfig): MatrixNativeDiagnostics {
    return decodeNativeDiagnostics(this.#client.start(JSON.stringify(config)));
  }

  stop(): void {
    this.#client.stop();
  }

  diagnostics(): MatrixNativeDiagnostics {
    return decodeNativeDiagnostics(this.#client.diagnostics());
  }

  pollEvents(): MatrixNativeEvent[] {
    return decodeNativeEvents(this.#client.pollEvents());
  }

  sendMessage(request: MatrixSendRequest): MatrixSendResult {
    return decodeSendResult(this.#client.sendMessage(JSON.stringify(request)));
  }

  resolveTarget(request: MatrixResolveTargetRequest): MatrixResolveTargetResult {
    return JSON.parse(this.#client.resolveTarget(JSON.stringify(request))) as MatrixResolveTargetResult;
  }

  joinRoom(request: MatrixJoinRequest): MatrixJoinResult {
    return JSON.parse(this.#client.joinRoom(JSON.stringify(request))) as MatrixJoinResult;
  }

  readMessages(request: MatrixReadMessagesRequest): MatrixReadMessagesResult {
    return JSON.parse(this.#client.readMessages(JSON.stringify(request))) as MatrixReadMessagesResult;
  }

  messageSummary(request: MatrixMessageSummaryRequest): MatrixMessageSummary | null {
    return JSON.parse(this.#client.messageSummary(JSON.stringify(request))) as MatrixMessageSummary | null;
  }

  editMessage(request: MatrixEditMessageRequest): MatrixEditMessageResult {
    return JSON.parse(this.#client.editMessage(JSON.stringify(request))) as MatrixEditMessageResult;
  }

  deleteMessage(request: MatrixDeleteMessageRequest): MatrixDeleteMessageResult {
    return JSON.parse(this.#client.deleteMessage(JSON.stringify(request))) as MatrixDeleteMessageResult;
  }

  pinMessage(request: MatrixPinMessageRequest): MatrixPinsResult {
    return JSON.parse(this.#client.pinMessage(JSON.stringify(request))) as MatrixPinsResult;
  }

  unpinMessage(request: MatrixPinMessageRequest): MatrixPinsResult {
    return JSON.parse(this.#client.unpinMessage(JSON.stringify(request))) as MatrixPinsResult;
  }

  listPins(request: MatrixListPinsRequest): MatrixPinsResult {
    return JSON.parse(this.#client.listPins(JSON.stringify(request))) as MatrixPinsResult;
  }

  memberInfo(request: MatrixMemberInfoRequest): MatrixMemberInfo {
    return JSON.parse(this.#client.memberInfo(JSON.stringify(request))) as MatrixMemberInfo;
  }

  channelInfo(request: MatrixChannelInfoRequest): MatrixChannelInfo {
    return JSON.parse(this.#client.channelInfo(JSON.stringify(request))) as MatrixChannelInfo;
  }

  uploadMedia(request: MatrixUploadMediaRequest): MatrixUploadMediaResult {
    return JSON.parse(this.#client.uploadMedia(JSON.stringify(request))) as MatrixUploadMediaResult;
  }

  downloadMedia(request: MatrixDownloadMediaRequest): MatrixDownloadMediaResult {
    return JSON.parse(this.#client.downloadMedia(JSON.stringify(request))) as MatrixDownloadMediaResult;
  }

  reactMessage(request: MatrixReactRequest): MatrixReactResult {
    return JSON.parse(this.#client.reactMessage(JSON.stringify(request))) as MatrixReactResult;
  }

  listReactions(request: MatrixListReactionsRequest): MatrixReactionSummary[] {
    return JSON.parse(this.#client.listReactions(JSON.stringify(request))) as MatrixReactionSummary[];
  }

  recordCustomEmojiUsage(request: MatrixEmojiUsageRequest): void {
    this.#client.recordCustomEmojiUsage(JSON.stringify(request));
  }

  listKnownShortcodes(request: MatrixListEmojiRequest = {}): string[] {
    return JSON.parse(this.#client.listKnownShortcodes(JSON.stringify(request))) as string[];
  }

  resolveLinkPreviews(request: MatrixResolveLinkPreviewsRequest): MatrixLinkPreviewResult {
    return JSON.parse(this.#client.resolveLinkPreviews(JSON.stringify(request))) as MatrixLinkPreviewResult;
  }

  setTyping(request: MatrixTypingRequest): void {
    this.#client.setTyping(JSON.stringify(request));
  }
}
