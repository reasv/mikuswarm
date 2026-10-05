import type { SessionDetailResponse } from '$lib/schemas';
import { hasRecordTurn } from '$lib/rollout';

/**
 * How often to re-poll the session detail so the view tracks status changes
 * WITHOUT a manual refresh (the live rollout stream is consumed separately; this
 * only keeps `status` / actuals fresh and drives LiveRollout mount/unmount). Fast
 * while `running` (catch settlement + live actuals), slower while resumable or
 * just-completed so a resume / follow-up-fold that reuses this id (settled→running)
 * is detected and re-mounts `LiveRollout`; sticky (no poll) once durably terminal.
 *
 * Kept in its own module free of the SvelteKit remote-function runtime so it is
 * unit-testable. `now` is injectable.
 */
const RUNNING_POLL_MS = 3000;
const RESUMABLE_POLL_MS = 8000;
/** A just-completed session can be resumed within seconds by a follow-up fold. */
const RECENT_COMPLETION_GRACE_MS = 20_000;

export function sessionPollInterval(
	data: SessionDetailResponse | undefined,
	now: number = Date.now()
): number | false {
	const s = data?.session;
	if (!s) return false;
	if (s.status === 'running') return RUNNING_POLL_MS;
	if (s.status === 'interrupted' || s.status === 'failed-resumable') return RESUMABLE_POLL_MS;
	if (
		s.status === 'completed' &&
		typeof s.completedAt === 'number' &&
		now - s.completedAt < RECENT_COMPLETION_GRACE_MS
	)
		return RESUMABLE_POLL_MS;
	return false;
}

/**
 * How long after a session completes its record turn may still be running
 * (spec SESSION-RECORDS §3.2). The record turn starts after the session is
 * marked completed and is bounded by `[session_records].timeout_ms` (default
 * 60 s); the margin covers the transcript flush that follows it.
 */
export const RECORD_SETTLE_WINDOW_MS = 90_000;
const RECORD_POLL_MS = 5000;

/**
 * Whether the session's record turn may still change what the view shows: the
 * session completed within {@link RECORD_SETTLE_WINDOW_MS} and the record plus
 * the record turn in the transcript have not both landed yet. A session that
 * does no work writes no record, so this stays true until the window closes:
 * polling is bounded by the window, never permanent.
 */
export function recordTurnPending(
	data: SessionDetailResponse | undefined,
	hasRecord: boolean,
	now: number = Date.now()
): boolean {
	const s = data?.session;
	if (!s || s.status !== 'completed' || typeof s.completedAt !== 'number') return false;
	if (now - s.completedAt >= RECORD_SETTLE_WINDOW_MS) return false;
	return !(hasRecord && hasRecordTurn(data!.transcript));
}

/** Poll interval for the record query: only while the record turn may be pending. */
export function recordPollInterval(
	data: SessionDetailResponse | undefined,
	hasRecord: boolean,
	now: number = Date.now()
): number | false {
	return recordTurnPending(data, hasRecord, now) ? RECORD_POLL_MS : false;
}

/**
 * Poll interval for the decisions query: decisions are written while the
 * session runs (at its start today; later points mid-rollout), so poll while
 * it runs. The refetch after the stream ends picks up the last rows.
 */
export function decisionsPollInterval(data: SessionDetailResponse | undefined): number | false {
	return data?.session.status === 'running' ? RECORD_POLL_MS : false;
}
