/**
 * Minimal client-side view of a timeline key's identity prefix.
 *
 * The backend's key grammar is `<provider>:<accountId>:<kind>:<channelId>[...]`
 * where provider and accountId are guaranteed colon-free (only the trailing
 * channelId may contain colons — Matrix room ids do). So the FIRST TWO segments
 * can be split off exactly without re-implementing the full grammar; this
 * module deliberately parses no further. Used purely for display (account tags
 * on channel cells / pipeline items) — any structural need beyond this belongs
 * in a server-side `parseTimelineKey` field like `GET /api/rooms` carries.
 */
export interface TimelineAccount {
	provider: string;
	accountId: string;
}

/** Extract `{provider, accountId}` from a timeline key, or undefined when the
 *  key is absent or lacks the two leading colon-delimited segments. */
export function timelineAccount(key: string | null | undefined): TimelineAccount | undefined {
	if (!key) return undefined;
	const c1 = key.indexOf(':');
	if (c1 <= 0) return undefined;
	const c2 = key.indexOf(':', c1 + 1);
	if (c2 === -1 || c2 === c1 + 1) return undefined;
	return { provider: key.slice(0, c1), accountId: key.slice(c1 + 1, c2) };
}

/** Stable grouping key for a (provider, account) pair. */
export function accountKey(a: TimelineAccount): string {
	return `${a.provider}:${a.accountId}`;
}

/** Count the distinct accounts among a set of timeline keys (unparseable keys
 *  are ignored). Display sites show account tags only when this exceeds 1. */
export function distinctAccounts(keys: Iterable<string | null | undefined>): number {
	const seen = new Set<string>();
	for (const key of keys) {
		const a = timelineAccount(key);
		if (a) seen.add(accountKey(a));
	}
	return seen.size;
}
