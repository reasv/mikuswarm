/**
 * Client-side agent model helpers (spec CONSOLE-MULTI-AGENT §2/§3).
 *
 * Given the `GET /api/agents` payload this module builds a lookup from
 * `"provider:accountId"` → `{ agentName, agentIndex }` and exposes:
 *
 *   - `buildAgentLookup`  — construct the map from the wire payload
 *   - `agentFor`          — timeline key → lookup entry (or undefined)
 *   - `distinctAgents`    — count distinct resolved agents across a key set
 *   - `platformOf`        — single provider name or "multi" for an agent
 *   - `needsAccountId`    — whether an accountId must be appended in a label
 *   - `agentAccent`       — deterministic accent color by agent index
 *
 * Mirrors the documentation style of `timeline-key.ts`.
 */

import type { AgentsResponse, AgentEntry } from '$lib/schemas';

/** One entry in the agent lookup map. */
export interface AgentLookupEntry {
	agentName: string;
	/** Config declaration index (0-based); drives `agentAccent`. */
	agentIndex: number;
}

/** Map from `"provider:accountId"` → agent lookup entry. */
export type AgentLookup = Map<string, AgentLookupEntry>;

/** Build the lookup map from the wire payload. */
export function buildAgentLookup(payload: AgentsResponse): AgentLookup {
	const map: AgentLookup = new Map();
	for (let i = 0; i < payload.agents.length; i++) {
		const agent = payload.agents[i];
		for (const acc of agent.accounts) {
			map.set(`${acc.provider}:${acc.accountId}`, { agentName: agent.name, agentIndex: i });
		}
	}
	return map;
}

/**
 * Look up the agent for a timeline key. Returns `undefined` when the key is
 * absent, unparseable, or references an account not in the current config
 * (spec §2 "unresolvable accounts" — never guess a default agent).
 */
export function agentFor(
	key: string | null | undefined,
	lookup: AgentLookup
): AgentLookupEntry | undefined {
	if (!key) return undefined;
	const c1 = key.indexOf(':');
	if (c1 <= 0) return undefined;
	const c2 = key.indexOf(':', c1 + 1);
	if (c2 === -1 || c2 === c1 + 1) return undefined;
	const provider = key.slice(0, c1);
	const accountId = key.slice(c1 + 1, c2);
	return lookup.get(`${provider}:${accountId}`);
}

/**
 * Count the distinct agents among a set of timeline keys. Unresolvable keys
 * are ignored (same philosophy as `distinctAccounts` in timeline-key.ts).
 * Display sites show agent chips only when this exceeds 1.
 */
export function distinctAgents(
	keys: Iterable<string | null | undefined>,
	lookup: AgentLookup
): number {
	const seen = new Set<string>();
	for (const key of keys) {
		const entry = agentFor(key, lookup);
		if (entry) seen.add(entry.agentName);
	}
	return seen.size;
}

// ── Label-grammar helpers (spec §3.2) ────────────────────────────────────────

/**
 * The provider sub-label for an agent-level surface (room-list tab, §3.2
 * first two rows). Returns the single provider name when all of the agent's
 * accounts share one provider, or `"multi"` when they span providers.
 * The slot is always occupied — an empty slot is not a valid state (§3.2).
 */
export function platformOf(agent: AgentEntry): string {
	if (agent.accounts.length === 0) return 'multi';
	const first = agent.accounts[0].provider;
	return agent.accounts.every((a) => a.provider === first) ? first : 'multi';
}

/**
 * Whether an `accountId` must be appended to disambiguate a row-level label
 * (spec §3.2 "Row-level, agent has >1 account on that provider").
 *
 * The rule is per-provider, not per-agent: an agent with one Matrix and one
 * Discord account never shows account ids because the provider already
 * identifies the door. Only when an agent has multiple accounts on the SAME
 * provider does the `accountId` append become necessary.
 *
 * @param agent        The resolved agent entry from the wire payload.
 * @param provider     The row's concrete provider (from the timeline key).
 */
export function needsAccountId(agent: AgentEntry, provider: string): boolean {
	return agent.accounts.filter((a) => a.provider === provider).length > 1;
}

// ── Accent color palette (spec §3.4) ─────────────────────────────────────────

/**
 * Fixed 8-color palette for agent accent dots / left borders. Colors are
 * tailwind-compatible CSS values chosen to harmonise with the zinc shadcn
 * theme and remain distinguishable in both light and dark modes.
 *
 * Index wraps modulo the palette length for deployments with >8 agents.
 */
const ACCENT_PALETTE = [
	'#6366f1', // indigo-500  (~4.1:1 on white)
	'#db2777', // pink-600    (was #ec4899 pink-500, too light on white)
	'#0d9488', // teal-600    (was #14b8a6 teal-500, too light on white)
	'#b45309', // amber-700   (was #f59e0b amber-500 — ~1.7:1 on white, now ~5:1)
	'#7c3aed', // violet-600  (was #8b5cf6 violet-500, slightly better on white)
	'#059669', // emerald-600 (was #10b981 emerald-500, too light on white)
	'#c2410c', // orange-700  (was #f97316 orange-500, too light on white)
	'#0e7490'  // cyan-700    (was #06b6d4 cyan-500, too light on white)
] as const;

/**
 * Deterministic accent color for an agent. `agentIndex` is the config
 * declaration order (0-based) from the `GET /api/agents` payload. The same
 * agent always maps to the same color across all surfaces, regardless of
 * which surfaces are visible.
 */
export function agentAccent(index: number): string {
	return ACCENT_PALETTE[index % ACCENT_PALETTE.length];
}
