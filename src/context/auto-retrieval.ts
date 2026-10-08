import type { ResolvedRetrievalConfig } from "../retrieval/index.js";
import type { MemoryRetrievalPipeline } from "../retrieval/auto/pipeline.js";
import type { RetrievalPlan } from "../retrieval/auto/types.js";

/**
 * Auto-retrieval dependencies of the context builder (ARCHITECTURE.md §9d
 * "Judged retrieval"). A live session's plan is started at launch, in
 * parallel with routing, and handed to the build as a ticket
 * (`BuildContextOptions.memoryRetrieval`). A room preview runs the pipeline
 * inline without the memory point; judged filters it meets follow `pending`,
 * though the recency layer it renders may still judge filters (billed and
 * attributed to the preview).
 */
export interface AutoRetrievalDeps {
  pipeline: MemoryRetrievalPipeline;
  config: ResolvedRetrievalConfig;
}

/**
 * Await a plan within `maxWaitMs`; null on timeout or failure. The plan
 * bounds its own stages (embed wait, late timeout, per-member re-rank
 * timeouts, the decision timeout); this is the build's own bound (the memory
 * point's timeout plus a grace).
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
