import { NativeMatrixCoreClient } from "./native-binding.js";
import type {
  MatrixChannelInfo,
  MatrixChannelInfoRequest,
  MatrixCreatePollRequest,
  MatrixCreatePollResult,
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
  MatrixPollVoteRequest,
  MatrixPollVoteResult,
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
  MatrixSetProfileRequest,
  MatrixSetProfileResult,
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
  sendMessage(requestJson: string): Promise<string>;
  resolveTarget(requestJson: string): Promise<string>;
  joinRoom(requestJson: string): Promise<string>;
  readMessages(requestJson: string): Promise<string>;
  messageSummary(requestJson: string): Promise<string>;
  editMessage(requestJson: string): Promise<string>;
  deleteMessage(requestJson: string): Promise<string>;
  pinMessage(requestJson: string): Promise<string>;
  unpinMessage(requestJson: string): Promise<string>;
  listPins(requestJson: string): Promise<string>;
  memberInfo(requestJson: string): Promise<string>;
  channelInfo(requestJson: string): Promise<string>;
  uploadMedia(requestJson: string): Promise<string>;
  downloadMedia(requestJson: string): Promise<string>;
  reactMessage(requestJson: string): Promise<string>;
  listReactions(requestJson: string): Promise<string>;
  recordCustomEmojiUsage(requestJson: string): void;
  listKnownShortcodes(requestJson: string): string;
  resolveLinkPreviews(requestJson: string): Promise<string>;
  setTyping(requestJson: string): Promise<void>;
  setProfile(requestJson: string): Promise<string>;
  createPoll(requestJson: string): Promise<string>;
  pollVote(requestJson: string): Promise<string>;
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

  async sendMessage(request: MatrixSendRequest): Promise<MatrixSendResult> {
    return decodeSendResult(await this.#client.sendMessage(JSON.stringify(request)));
  }

  async resolveTarget(request: MatrixResolveTargetRequest): Promise<MatrixResolveTargetResult> {
    return parseNativeJson(await this.#client.resolveTarget(JSON.stringify(request)), "resolveTarget");
  }

  async joinRoom(request: MatrixJoinRequest): Promise<MatrixJoinResult> {
    return parseNativeJson(await this.#client.joinRoom(JSON.stringify(request)), "joinRoom");
  }

  async readMessages(request: MatrixReadMessagesRequest): Promise<MatrixReadMessagesResult> {
    return parseNativeJson(await this.#client.readMessages(JSON.stringify(request)), "readMessages");
  }

  async messageSummary(request: MatrixMessageSummaryRequest): Promise<MatrixMessageSummary | null> {
    return parseNativeJson(await this.#client.messageSummary(JSON.stringify(request)), "messageSummary");
  }

  async editMessage(request: MatrixEditMessageRequest): Promise<MatrixEditMessageResult> {
    return parseNativeJson(await this.#client.editMessage(JSON.stringify(request)), "editMessage");
  }

  async deleteMessage(request: MatrixDeleteMessageRequest): Promise<MatrixDeleteMessageResult> {
    return parseNativeJson(await this.#client.deleteMessage(JSON.stringify(request)), "deleteMessage");
  }

  async pinMessage(request: MatrixPinMessageRequest): Promise<MatrixPinsResult> {
    return parseNativeJson(await this.#client.pinMessage(JSON.stringify(request)), "pinMessage");
  }

  async unpinMessage(request: MatrixPinMessageRequest): Promise<MatrixPinsResult> {
    return parseNativeJson(await this.#client.unpinMessage(JSON.stringify(request)), "unpinMessage");
  }

  async listPins(request: MatrixListPinsRequest): Promise<MatrixPinsResult> {
    return parseNativeJson(await this.#client.listPins(JSON.stringify(request)), "listPins");
  }

  async memberInfo(request: MatrixMemberInfoRequest): Promise<MatrixMemberInfo> {
    return parseNativeJson(await this.#client.memberInfo(JSON.stringify(request)), "memberInfo");
  }

  async channelInfo(request: MatrixChannelInfoRequest): Promise<MatrixChannelInfo> {
    return parseNativeJson(await this.#client.channelInfo(JSON.stringify(request)), "channelInfo");
  }

  async uploadMedia(request: MatrixUploadMediaRequest): Promise<MatrixUploadMediaResult> {
    return parseNativeJson(await this.#client.uploadMedia(JSON.stringify(request)), "uploadMedia");
  }

  async downloadMedia(request: MatrixDownloadMediaRequest): Promise<MatrixDownloadMediaResult> {
    return parseNativeJson(await this.#client.downloadMedia(JSON.stringify(request)), "downloadMedia");
  }

  async reactMessage(request: MatrixReactRequest): Promise<MatrixReactResult> {
    return parseNativeJson(await this.#client.reactMessage(JSON.stringify(request)), "reactMessage");
  }

  async listReactions(request: MatrixListReactionsRequest): Promise<MatrixReactionSummary[]> {
    return parseNativeJson(await this.#client.listReactions(JSON.stringify(request)), "listReactions");
  }

  recordCustomEmojiUsage(request: MatrixEmojiUsageRequest): void {
    this.#client.recordCustomEmojiUsage(JSON.stringify(request));
  }

  listKnownShortcodes(request: MatrixListEmojiRequest = {}): string[] {
    return parseNativeJson(this.#client.listKnownShortcodes(JSON.stringify(request)), "listKnownShortcodes");
  }

  async resolveLinkPreviews(request: MatrixResolveLinkPreviewsRequest): Promise<MatrixLinkPreviewResult> {
    return parseNativeJson(await this.#client.resolveLinkPreviews(JSON.stringify(request)), "resolveLinkPreviews");
  }

  async setTyping(request: MatrixTypingRequest): Promise<void> {
    await this.#client.setTyping(JSON.stringify(request));
  }

  async setProfile(request: MatrixSetProfileRequest): Promise<MatrixSetProfileResult> {
    return parseNativeJson(await this.#client.setProfile(JSON.stringify(request)), "setProfile");
  }

  async createPoll(request: MatrixCreatePollRequest): Promise<MatrixCreatePollResult> {
    return parseNativeJson(await this.#client.createPoll(JSON.stringify(request)), "createPoll");
  }

  async pollVote(request: MatrixPollVoteRequest): Promise<MatrixPollVoteResult> {
    return parseNativeJson(await this.#client.pollVote(JSON.stringify(request)), "pollVote");
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
