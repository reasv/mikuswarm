import type { PipelineId } from '$lib/schemas';

/**
 * Per-pool terminal states safe to manually retry (ARCHITECTURE.md §11 / spec
 * §3.7). Mirrors the backend's `PIPELINE_SAFE_RETRY` so the UI only offers retry
 * where the server will accept it; a stale click still gets a benign 409.
 */
export const PIPELINE_SAFE_RETRY: Record<PipelineId, readonly string[]> = {
	enrichment: ['failed', 'complete', 'skipped'],
	captioning: ['failed', 'complete', 'skipped'],
	summarization: ['failed'],
	diary: ['failed', 'skipped']
};

export function isRetryable(pool: PipelineId, status: string): boolean {
	return PIPELINE_SAFE_RETRY[pool].includes(status);
}
