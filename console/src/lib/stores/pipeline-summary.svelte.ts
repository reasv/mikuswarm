/**
 * The Pipelines-area top-bar summary (ARCHITECTURE.md §11): aggregate failing +
 * retrying counts and total in-flight across all four pools. The Pipelines list
 * publishes here as the dashboard feed loads, mirroring how `contextSummary` is
 * the Conversations-area top-bar summary. The top bar shows whichever matches the
 * active route.
 */
class PipelineSummary {
	failing = $state<number | null>(null);
	retrying = $state(0);
	inFlight = $state(0);

	set(data: { failing: number; retrying: number; inFlight: number }) {
		this.failing = data.failing;
		this.retrying = data.retrying;
		this.inFlight = data.inFlight;
	}

	clear() {
		this.failing = null;
		this.retrying = 0;
		this.inFlight = 0;
	}
}

export const pipelineSummary = new PipelineSummary();
