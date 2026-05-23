import { createRequire } from "node:module";

export declare class MatrixCoreClient {
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
}

const require = createRequire(import.meta.url);
const binding = require("../../npm/index.js") as { MatrixCoreClient: typeof MatrixCoreClient };

export const NativeMatrixCoreClient = binding.MatrixCoreClient;
