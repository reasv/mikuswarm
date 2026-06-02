/**
 * The current Col-2 context summary surfaced in the top bar (spec §11): tier token
 * totals, cache boundaries, and a live indicator. Room/session views publish here
 * as their data loads so the top bar stays decoupled from the active view.
 */
export interface ContextSummaryData {
	tokenEstimate: number | null;
	compactTokens: number | null;
	richTokens: number | null;
	cacheBoundaries: readonly string[];
	live: boolean;
}

class ContextSummary {
	tokenEstimate = $state<number | null>(null);
	compactTokens = $state<number | null>(null);
	richTokens = $state<number | null>(null);
	cacheBoundaries = $state<readonly string[]>([]);
	live = $state(false);

	set(data: Partial<ContextSummaryData>) {
		if ('tokenEstimate' in data) this.tokenEstimate = data.tokenEstimate ?? null;
		if ('compactTokens' in data) this.compactTokens = data.compactTokens ?? null;
		if ('richTokens' in data) this.richTokens = data.richTokens ?? null;
		if ('cacheBoundaries' in data) this.cacheBoundaries = data.cacheBoundaries ?? [];
		if ('live' in data) this.live = data.live ?? false;
	}

	clear() {
		this.tokenEstimate = null;
		this.compactTokens = null;
		this.richTokens = null;
		this.cacheBoundaries = [];
		this.live = false;
	}
}

export const contextSummary = new ContextSummary();
