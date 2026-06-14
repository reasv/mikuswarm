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

	get mode(): 'empty' | 'room' | 'session' {
		if (this.sessionId) return 'session';
		if (this.roomKey) return 'room';
		return 'empty';
	}
}

export const selection = new Selection();
