import type { PipelineId } from '$lib/schemas';

/**
 * Pipelines-area selection state (ARCHITECTURE.md §11), the sibling of the
 * conversations `selection` store. A selected pool, optionally an item within it,
 * plus the Col2 status/room filter chips. Selecting a different pool clears the
 * item and filters (a fresh drill-down); changing a filter clears the item (it may
 * no longer be in the filtered list).
 */
class PipelineSelection {
	pool = $state<PipelineId | null>(null);
	itemId = $state<string | null>(null);
	status = $state<string | null>(null);
	room = $state<string | null>(null);

	selectPool(pool: PipelineId) {
		if (this.pool !== pool) {
			this.itemId = null;
			this.status = null;
			this.room = null;
		}
		this.pool = pool;
	}

	selectItem(id: string) {
		this.itemId = id;
	}

	clearItem() {
		this.itemId = null;
	}

	/** Toggle the status filter chip; null clears it. Drops the item selection. */
	setStatus(status: string | null) {
		this.status = this.status === status ? null : status;
		this.itemId = null;
	}

	setRoom(room: string | null) {
		this.room = room;
		this.itemId = null;
	}

	get mode(): 'empty' | 'pool' | 'item' {
		if (this.itemId) return 'item';
		if (this.pool) return 'pool';
		return 'empty';
	}
}

export const pipelineSelection = new PipelineSelection();
