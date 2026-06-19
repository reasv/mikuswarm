import { writeContextDump } from "../observability/index.js";
import type { BuiltContext } from "./builder.js";

/**
 * Cache-boundary markers for a built context (spec §8 endpoint shape, §11 top bar).
 *
 * Single source of truth: BOTH the on-disk context dump ({@link dumpBuiltContext})
 * and the `/api/rooms/:key/context` endpoint reference this const, so the two
 * cannot drift. The value is an aspirational placeholder — real cache-breakpoint
 * logic does not exist yet (see issues doc) — but it must be identical wherever it
 * is surfaced.
 */
export const CACHE_BOUNDARIES: readonly string[] = ["after_system", "after_compact_tier"];

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
    cacheBoundaries: [...CACHE_BOUNDARIES],
    // Tool-definition block (out-of-band wire `tools[]`): its estimate is already
    // inside `tokenEstimate` above; surface the whole + per-tool breakdown so the
    // dump explains the otherwise-invisible bulk of the estimate (dump/estimate
    // parity, issue #9). Omitted when no tools were supplied to the build.
    ...(context.toolBlock
      ? {
          toolBlock: {
            tokenEstimate: context.toolBlock.tokenEstimate,
            segments: context.toolBlock.segments,
          },
        }
      : {}),
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

