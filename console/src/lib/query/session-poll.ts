import type { SessionDetailResponse } from '$lib/schemas';

/**
 * How often to re-poll the session detail so the view tracks status changes
 * WITHOUT a manual refresh (the live rollout stream is consumed separately; this
 * only keeps `status` / actuals fresh and drives LiveRollout mount/unmount). Fast
 * while `running` (catch settlement + live actuals), slower while resumable or
 * just-completed so a resume / follow-up-fold that reuses this id (settled→running)
 * is detected and re-mounts `LiveRollout`; sticky (no poll) once durably terminal.
 *
 * Kept in its own dependency-free module (type-only import) so it is unit-testable
 * without dragging in the SvelteKit remote-function runtime. `now` is injectable.
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
