import { writeContextDump } from "../observability/index.js";
import type { BuiltContext } from "./builder.js";

export async function dumpBuiltContext(
  dumpDir: string,
  timelineKey: string,
  sessionId: string,
  context: BuiltContext,
  triggerEventId?: string,
): Promise<string> {
  return writeContextDump(dumpDir, {
    sessionId,
    timelineKey,
    createdAt: new Date().toISOString(),
    triggerEventId,
    tokenEstimate: context.tokenEstimate,
    cacheBoundaries: ["after_system", "after_compact_tier"],
    imageBlocks: context.imageBlocks.map((block, index) => ({
      eventId: block.eventId,
      attachmentId: block.attachmentId,
      position: index,
      sizeBytes: Buffer.byteLength(block.dataBase64, "base64"),
    })),
    messages: context.messages.map((message) => ({
      type: message.type,
      role: message.role,
      tier: message.tier,
      tokenEstimate: message.tokenEstimate,
      content: message.content,
    })),
  });
}

