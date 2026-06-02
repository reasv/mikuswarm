/**
 * Console selection state (spec §11): a room, and optionally a session within it.
 * Selecting a session is a drill-down inside its room; selecting a different room
 * clears the session. `mode` drives Col 2 (room vs session view).
 */
class Selection {
	roomKey = $state<string | null>(null);
	sessionId = $state<string | null>(null);

	selectRoom(key: string) {
		if (this.roomKey !== key) this.sessionId = null;
		this.roomKey = key;
	}

	selectSession(id: string) {
		this.sessionId = id;
	}

	clearSession() {
		this.sessionId = null;
	}

	get mode(): 'empty' | 'room' | 'session' {
		if (this.sessionId) return 'session';
		if (this.roomKey) return 'room';
		return 'empty';
	}
}

export const selection = new Selection();
