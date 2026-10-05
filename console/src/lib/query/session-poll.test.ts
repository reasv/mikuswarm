import { describe, it, expect } from 'vitest';
import {
	decisionsPollInterval,
	RECORD_SETTLE_WINDOW_MS,
	recordPollInterval,
	recordTurnPending,
	sessionPollInterval
} from './session-poll';
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

describe('record turn polling (SESSION-RECORDS §3.2)', () => {
	const now = 1_000_000;
	const withTranscript = (d: SessionDetailResponse, transcript: unknown[]) =>
		({ ...d, transcript }) as SessionDetailResponse;
	const recordTurn = [{ role: 'user', content: 'write it', harness: { kind: 'record_turn' } }];

	it('is pending right after completion until the record and its turn have landed', () => {
		const done = detail('completed', now - 5_000);
		expect(recordTurnPending(done, false, now)).toBe(true);
		// The record row lands before the transcript flush: still pending.
		expect(recordTurnPending(done, true, now)).toBe(true);
		expect(recordTurnPending(withTranscript(done, recordTurn), true, now)).toBe(false);
	});

	it('is bounded by the settle window (a session with no work writes no record)', () => {
		const old = detail('completed', now - RECORD_SETTLE_WINDOW_MS);
		expect(recordTurnPending(old, false, now)).toBe(false);
		expect(recordPollInterval(old, false, now)).toBe(false);
		expect(recordPollInterval(detail('completed', now - 1_000), false, now)).toBe(5000);
	});

	it('never polls the record of a running, failed or unknown session', () => {
		expect(recordTurnPending(detail('running'), false, now)).toBe(false);
		expect(recordTurnPending(detail('failed', now), false, now)).toBe(false);
		expect(recordTurnPending(undefined, false, now)).toBe(false);
	});

	it('polls decisions only while the session runs', () => {
		expect(decisionsPollInterval(detail('running'))).toBe(5000);
		expect(decisionsPollInterval(detail('completed', now))).toBe(false);
		expect(decisionsPollInterval(undefined)).toBe(false);
	});
});
