import { page } from '$app/state';

/**
 * Console selection state (ARCHITECTURE.md §11): a room, and optionally a session
 * within it. The URL is the source of truth — these are reactive getters over the
 * conversations route's query params (`?room=…&session=…`), so deep-links, refresh,
 * and browser back/forward all reflect the selection, and every selection control is
 * a real `<a>` link (see `$lib/nav`). `mode` drives Col 2 (room vs session view).
 *
 * Selecting a session is a drill-down inside its room; a room link omits `session`,
 * so clicking a room always returns to room view even while a session is open. A
 * session may be deep-linked without a room (e.g. the scheduler's waiter links): that
 * is a valid `session` mode — Col 2 renders the session by id regardless of room.
 */
class Selection {
	get roomKey(): string | null {
		return page.url.searchParams.get('room');
	}

	get sessionId(): string | null {
		return page.url.searchParams.get('session');
	}

	/**
	 * Deep link into a session's rollout (spec REFUSAL-HANDLING §12.3 incident
	 * log): `branch` (a stored branch number; 0/absent = live), `call` (a judged
	 * tool call id) and `attempt` (a send-contract ending attempt).
	 */
	get focus(): { branchNo: number | null; toolCallId: string | null; attemptNo: number | null } | null {
		const sp = page.url.searchParams;
		const int = (v: string | null) => (v != null && /^\d+$/.test(v) ? Number(v) : null);
		const focus = { branchNo: int(sp.get('branch')), toolCallId: sp.get('call') || null, attemptNo: int(sp.get('attempt')) };
		return focus.branchNo == null && focus.toolCallId == null && focus.attemptNo == null ? null : focus;
	}

	get mode(): 'empty' | 'room' | 'session' {
		if (this.sessionId) return 'session';
		if (this.roomKey) return 'room';
		return 'empty';
	}
}

export const selection = new Selection();
