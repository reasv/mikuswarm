import { createRequire } from "node:module";

export declare class MatrixCoreClient {
  start(configJson: string): string;
  stop(): void;
  pollEvents(): string;
  diagnostics(): string;
  sendMessage(requestJson: string): string;
  resolveTarget(requestJson: string): string;
  joinRoom(requestJson: string): string;
  readMessages(requestJson: string): string;
  messageSummary(requestJson: string): Promise<string>;
  editMessage(requestJson: string): string;
  deleteMessage(requestJson: string): string;
  pinMessage(requestJson: string): string;
  unpinMessage(requestJson: string): string;
  listPins(requestJson: string): string;
  memberInfo(requestJson: string): Promise<string>;
  channelInfo(requestJson: string): string;
  uploadMedia(requestJson: string): string;
  downloadMedia(requestJson: string): Promise<string>;
  reactMessage(requestJson: string): string;
  listReactions(requestJson: string): string;
  recordCustomEmojiUsage(requestJson: string): void;
  listKnownShortcodes(requestJson: string): string;
  resolveLinkPreviews(requestJson: string): Promise<string>;
  setTyping(requestJson: string): void;
}

const require = createRequire(import.meta.url);
const binding = require("../../npm/index.js") as { MatrixCoreClient: typeof MatrixCoreClient };

export const NativeMatrixCoreClient = binding.MatrixCoreClient;
