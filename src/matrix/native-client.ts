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
    return parseNativeJson(this.#client.resolveTarget(JSON.stringify(request)), "resolveTarget");
  }

  joinRoom(request: MatrixJoinRequest): MatrixJoinResult {
    return parseNativeJson(this.#client.joinRoom(JSON.stringify(request)), "joinRoom");
  }

  readMessages(request: MatrixReadMessagesRequest): MatrixReadMessagesResult {
    return parseNativeJson(this.#client.readMessages(JSON.stringify(request)), "readMessages");
  }

  messageSummary(request: MatrixMessageSummaryRequest): MatrixMessageSummary | null {
    return parseNativeJson(this.#client.messageSummary(JSON.stringify(request)), "messageSummary");
  }

  editMessage(request: MatrixEditMessageRequest): MatrixEditMessageResult {
    return parseNativeJson(this.#client.editMessage(JSON.stringify(request)), "editMessage");
  }

  deleteMessage(request: MatrixDeleteMessageRequest): MatrixDeleteMessageResult {
    return parseNativeJson(this.#client.deleteMessage(JSON.stringify(request)), "deleteMessage");
  }

  pinMessage(request: MatrixPinMessageRequest): MatrixPinsResult {
    return parseNativeJson(this.#client.pinMessage(JSON.stringify(request)), "pinMessage");
  }

  unpinMessage(request: MatrixPinMessageRequest): MatrixPinsResult {
    return parseNativeJson(this.#client.unpinMessage(JSON.stringify(request)), "unpinMessage");
  }

  listPins(request: MatrixListPinsRequest): MatrixPinsResult {
    return parseNativeJson(this.#client.listPins(JSON.stringify(request)), "listPins");
  }

  memberInfo(request: MatrixMemberInfoRequest): MatrixMemberInfo {
    return parseNativeJson(this.#client.memberInfo(JSON.stringify(request)), "memberInfo");
  }

  channelInfo(request: MatrixChannelInfoRequest): MatrixChannelInfo {
    return parseNativeJson(this.#client.channelInfo(JSON.stringify(request)), "channelInfo");
  }

  uploadMedia(request: MatrixUploadMediaRequest): MatrixUploadMediaResult {
    return parseNativeJson(this.#client.uploadMedia(JSON.stringify(request)), "uploadMedia");
  }

  downloadMedia(request: MatrixDownloadMediaRequest): MatrixDownloadMediaResult {
    return parseNativeJson(this.#client.downloadMedia(JSON.stringify(request)), "downloadMedia");
  }

  reactMessage(request: MatrixReactRequest): MatrixReactResult {
    return parseNativeJson(this.#client.reactMessage(JSON.stringify(request)), "reactMessage");
  }

  listReactions(request: MatrixListReactionsRequest): MatrixReactionSummary[] {
    return parseNativeJson(this.#client.listReactions(JSON.stringify(request)), "listReactions");
  }

  recordCustomEmojiUsage(request: MatrixEmojiUsageRequest): void {
    this.#client.recordCustomEmojiUsage(JSON.stringify(request));
  }

  listKnownShortcodes(request: MatrixListEmojiRequest = {}): string[] {
    return parseNativeJson(this.#client.listKnownShortcodes(JSON.stringify(request)), "listKnownShortcodes");
  }

  resolveLinkPreviews(request: MatrixResolveLinkPreviewsRequest): MatrixLinkPreviewResult {
    return parseNativeJson(this.#client.resolveLinkPreviews(JSON.stringify(request)), "resolveLinkPreviews");
  }

  setTyping(request: MatrixTypingRequest): void {
    this.#client.setTyping(JSON.stringify(request));
  }
}

function parseNativeJson<T>(payload: string, operation: string): T {
  const parsed = JSON.parse(payload) as unknown;
  if (isRecord(parsed) && typeof parsed.error === "string") {
    throw new Error(`Matrix native ${operation} failed: ${parsed.error}`);
  }
  return parsed as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
