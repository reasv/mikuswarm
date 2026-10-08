import type { ResolvedRetrievalConfig } from "../retrieval/index.js";
import type { MemoryRetrievalPipeline } from "../retrieval/auto/pipeline.js";
import type { RetrievalPlan } from "../retrieval/auto/types.js";

/**
 * Auto-retrieval dependencies of the context builder (ARCHITECTURE.md §9d
 * "Judged retrieval"). A live session's plan is started at launch, in
 * parallel with routing, and handed to the build as a promise
 * (`BuildContextOptions.memoryRetrieval`); a build without one (a room
 * preview) runs the pipeline inline, never judged, so a preview never bills a
 * decision call.
 */
export interface AutoRetrievalDeps {
  pipeline: MemoryRetrievalPipeline;
  config: ResolvedRetrievalConfig;
}

/**
 * Await a launch-time plan within `maxWaitMs`; null on timeout or failure.
 * The plan bounds its own stages (embed wait, late timeout, per-member
 * re-rank timeouts, the decision timeout); this is the outer safety net.
 */
export async function awaitPlan(
  plan: Promise<RetrievalPlan | null>,
  maxWaitMs: number,
  onError?: (error: unknown) => void,
): Promise<RetrievalPlan | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      plan,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), maxWaitMs);
      }),
    ]);
  } catch (error) {
    onError?.(error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
