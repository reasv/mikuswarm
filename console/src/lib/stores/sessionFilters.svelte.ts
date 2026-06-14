/**
 * Sessions filter state (console sessions filter, ARCHITECTURE.md §11). Drives the
 * default-collapsed filter panel above the session list: a free-text trigger-message
 * search plus status / session-type selection. The committed values here feed
 * `roomSessionsQuery` (and the TanStack cache key), so any change refetches the list
 * server-side. The search box debounces into `q` so we don't refetch per keystroke.
 *
 * State is module-global (one panel at a time). It is reset on room change by the
 * panel, since the available session types are room-specific.
 */
class SessionFilters {
	/** Panel starts collapsed; the disclosure header toggles it (open = expanded). */
	open = $state(false);
	/** Committed (debounced) free-text query over trigger messages. */
	q = $state('');
	/** Selected statuses (OR within the category). Empty = no status filter. */
	statuses = $state<string[]>([]);
	/** Selected session types (OR within the category). Empty = no type filter. */
	types = $state<string[]>([]);

	/** Number of active filter dimensions, for the collapsed-header badge. */
	get activeCount(): number {
		return (
			(this.q.trim().length > 0 ? 1 : 0) +
			(this.statuses.length > 0 ? 1 : 0) +
			(this.types.length > 0 ? 1 : 0)
		);
	}

	get hasActive(): boolean {
		return this.activeCount > 0;
	}

	toggleStatus(status: string): void {
		this.statuses = this.statuses.includes(status)
			? this.statuses.filter((s) => s !== status)
			: [...this.statuses, status];
	}

	toggleType(type: string): void {
		this.types = this.types.includes(type)
			? this.types.filter((t) => t !== type)
			: [...this.types, type];
	}

	/** Clear every filter (the panel's "Clear" affordance). Leaves `open` as-is. */
	clear(): void {
		this.q = '';
		this.statuses = [];
		this.types = [];
	}
}

export const sessionFilters = new SessionFilters();
