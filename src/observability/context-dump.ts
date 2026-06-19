import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "../config/redaction.js";

export interface ContextDumpMessage {
  type?: "system" | "chatEvent" | "triggerGroup" | "summaryLayer" | "diaryLayer" | "satellite";
  role: string;
  tier?: "system" | "compact" | "rich" | "mixed" | "runtime" | "trigger" | "summary" | "diary";
  tokenEstimate?: number;
  content: unknown;
}

export interface ContextDump {
  sessionId: string;
  timelineKey: string;
  createdAt: string;
  triggerEventId?: string;
  tokenEstimate?: number;
  cacheBoundaries?: string[];
  /**
   * Tool-definition block accounting (out-of-band wire `tools[]`): the whole-block
   * estimate (already included in `tokenEstimate`) plus the per-tool breakdown.
   * Present only when the build was given a tool set. Not a message.
   */
  toolBlock?: {
    tokenEstimate: number;
    segments: Array<{ name: string; tokenEstimate: number }>;
  };
  imageBlocks?: Array<{
    eventId: string;
    attachmentId: string;
    position: number;
    sizeBytes?: number;
  }>;
  messages: ContextDumpMessage[];
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
}

export async function writeContextDump(dumpDir: string, dump: ContextDump): Promise<string> {
  await mkdir(dumpDir, { recursive: true });
  const stamp = safeFilename(dump.createdAt);
  const fileName = `${safeFilename(dump.timelineKey)}.${safeFilename(dump.sessionId)}.${stamp}.json`;
  const filePath = path.join(dumpDir, fileName);
  const serialized = `${redactSecrets(JSON.stringify(dump, null, 2))}\n`;
  await writeFile(filePath, serialized, "utf8");
  return filePath;
}
