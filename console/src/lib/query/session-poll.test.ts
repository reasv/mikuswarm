import { describe, it, expect } from 'vitest';
import { sessionPollInterval } from './session-poll';
import type { SessionDetailResponse } from '$lib/schemas';

/** Minimal session-detail stub — only the fields the poll inspects matter. */
function detail(status: string, completedAt: number | null = null): SessionDetailResponse {
	return {
		session: { status, completedAt } as SessionDetailResponse['session'],
		contextSnapshot: [],
		transcript: [],
		rolloutStartIndex: 0,
		contextDumpPath: null
	} as SessionDetailResponse;
}

describe('sessionPollInterval', () => {
	it('does not poll when there is no data yet', () => {
		expect(sessionPollInterval(undefined)).toBe(false);
	});

	it('polls fast while running', () => {
		expect(sessionPollInterval(detail('running'))).toBe(3000);
	});

	it('polls slower while resumable (interrupted / failed-resumable)', () => {
		expect(sessionPollInterval(detail('interrupted'))).toBe(8000);
		expect(sessionPollInterval(detail('failed-resumable'))).toBe(8000);
	});

	it('polls briefly after a recent completion (follow-up-fold window), then goes sticky', () => {
		const now = 1_000_000;
		// Completed 5s ago → still within the grace window → poll.
		expect(sessionPollInterval(detail('completed', now - 5_000), now)).toBe(8000);
		// Completed 30s ago → past the window → sticky.
		expect(sessionPollInterval(detail('completed', now - 30_000), now)).toBe(false);
		// Completed with no timestamp → sticky.
		expect(sessionPollInterval(detail('completed', null), now)).toBe(false);
	});

	it('does not poll other terminal states', () => {
		expect(sessionPollInterval(detail('discarded'))).toBe(false);
	});
});
