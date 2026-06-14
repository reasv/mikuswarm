import { page } from '$app/state';
import type { PipelineId } from '$lib/schemas';

const POOLS = new Set<PipelineId>(['enrichment', 'captioning', 'summarization', 'diary']);

/**
 * Pipelines-area selection state (ARCHITECTURE.md §11), the sibling of the
 * conversations `selection` store. Like it, the URL is the source of truth: these are
 * reactive getters over the `/pipelines` route's query params
 * (`?pool=…&status=…&room=…&item=…`), so pools, filters, and items are all
 * deep-linkable and the selection controls are real `<a>` links (see `$lib/nav`).
 *
 * A pool link omits item/status/room (a fresh drill-down); changing a filter omits
 * `item` (it may no longer be in the filtered list). `pool` is validated against the
 * known set so a malformed deep-link can't index the per-pool chip table; `itemId`
 * is gated on a valid pool so an item never resolves without its pool (the detail
 * query needs both).
 */
class PipelineSelection {
	get pool(): PipelineId | null {
		const p = page.url.searchParams.get('pool');
		return p && POOLS.has(p as PipelineId) ? (p as PipelineId) : null;
	}

	get itemId(): string | null {
		return this.pool ? page.url.searchParams.get('item') : null;
	}

	get status(): string | null {
		return page.url.searchParams.get('status');
	}

	get room(): string | null {
		return page.url.searchParams.get('room');
	}

	get mode(): 'empty' | 'pool' | 'item' {
		if (this.itemId) return 'item';
		if (this.pool) return 'pool';
		return 'empty';
	}
}

export const pipelineSelection = new PipelineSelection();
