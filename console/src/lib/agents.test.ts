import { describe, it, expect } from 'vitest';
import {
	buildAgentLookup,
	agentFor,
	distinctAgents,
	platformOf,
	needsAccountId,
	agentAccent
} from './agents';
import type { AgentsResponse } from '$lib/schemas';

// ── Fixture payload (mirrors demo fixture shape) ─────────────────────────────

const MULTI_AGENT_PAYLOAD: AgentsResponse = {
	mode: 'agents',
	agents: [
		{
			name: 'aria',
			accounts: [
				{ provider: 'matrix', accountId: 'aria' },
				{ provider: 'discord', accountId: 'aria-dc' }
			]
		},
		{
			name: 'nova',
			accounts: [{ provider: 'discord', accountId: 'nova' }]
		}
	]
};

const LEGACY_PAYLOAD: AgentsResponse = { mode: 'legacy', agents: [] };

// ── buildAgentLookup / agentFor ──────────────────────────────────────────────

describe('buildAgentLookup', () => {
	it('maps provider:accountId to the correct agent and index', () => {
		const lookup = buildAgentLookup(MULTI_AGENT_PAYLOAD);
		expect(lookup.get('matrix:aria')).toEqual({ agentName: 'aria', agentIndex: 0 });
		expect(lookup.get('discord:aria-dc')).toEqual({ agentName: 'aria', agentIndex: 0 });
		expect(lookup.get('discord:nova')).toEqual({ agentName: 'nova', agentIndex: 1 });
	});

	it('returns an empty map for a legacy payload', () => {
		const lookup = buildAgentLookup(LEGACY_PAYLOAD);
		expect(lookup.size).toBe(0);
	});
});

describe('agentFor', () => {
	const lookup = buildAgentLookup(MULTI_AGENT_PAYLOAD);

	it('resolves a Matrix timeline key', () => {
		expect(agentFor('matrix:aria:room:!general:example.org', lookup)).toEqual({
			agentName: 'aria',
			agentIndex: 0
		});
	});

	it('resolves a Discord timeline key', () => {
		expect(agentFor('discord:nova:room:1002', lookup)).toEqual({
			agentName: 'nova',
			agentIndex: 1
		});
	});

	it('is unconfused by colons in a Matrix room id', () => {
		expect(agentFor('matrix:aria:room:!abc:matrix.example.org', lookup)?.agentName).toBe('aria');
	});

	it('handles thread sub-timeline keys', () => {
		expect(agentFor('discord:aria-dc:room:1001:thread:42', lookup)?.agentName).toBe('aria');
	});

	it('returns undefined for absent or malformed keys', () => {
		expect(agentFor(null, lookup)).toBeUndefined();
		expect(agentFor(undefined, lookup)).toBeUndefined();
		expect(agentFor('', lookup)).toBeUndefined();
		expect(agentFor('no-colons', lookup)).toBeUndefined();
		expect(agentFor('onlyprovider:', lookup)).toBeUndefined();
		expect(agentFor(':empty:provider', lookup)).toBeUndefined();
		expect(agentFor('a::emptyaccount', lookup)).toBeUndefined();
	});

	it('returns undefined for an account not in the lookup (unresolvable)', () => {
		expect(agentFor('matrix:unknown:room:!foo:example.org', lookup)).toBeUndefined();
	});
});

// ── distinctAgents ───────────────────────────────────────────────────────────

describe('distinctAgents', () => {
	const lookup = buildAgentLookup(MULTI_AGENT_PAYLOAD);

	it('counts distinct resolved agents, ignoring unparseable and unresolvable keys', () => {
		expect(
			distinctAgents(
				[
					'matrix:aria:room:!a:example.org',
					'matrix:aria:room:!b:example.org',
					'discord:aria-dc:room:1001',
					'discord:nova:room:1002',
					null,
					'garbage',
					'matrix:unknown:room:!c:example.org'
				],
				lookup
			)
		).toBe(2); // aria + nova
	});

	it('returns 0 for an empty iterable', () => {
		expect(distinctAgents([], lookup)).toBe(0);
	});

	it('returns 0 when no key resolves to a known agent', () => {
		expect(distinctAgents(['garbage', null, 'matrix:ghost:room:!x:example.org'], lookup)).toBe(0);
	});

	it('returns 1 when all resolvable keys belong to the same agent', () => {
		expect(
			distinctAgents(
				['matrix:aria:room:!a:example.org', 'discord:aria-dc:room:1001'],
				lookup
			)
		).toBe(1);
	});
});

// ── platformOf (label-grammar helper, spec §3.2) ─────────────────────────────

describe('platformOf', () => {
	it('returns the single provider when all accounts share one provider', () => {
		// nova: discord-only
		expect(platformOf(MULTI_AGENT_PAYLOAD.agents[1])).toBe('discord');
	});

	it('returns "multi" when accounts span providers', () => {
		// aria: matrix + discord
		expect(platformOf(MULTI_AGENT_PAYLOAD.agents[0])).toBe('multi');
	});

	it('returns "multi" for an agent with no accounts (degenerate edge case)', () => {
		expect(platformOf({ name: 'empty', accounts: [] })).toBe('multi');
	});

	it('returns the provider for a single-account agent', () => {
		expect(platformOf({ name: 'solo', accounts: [{ provider: 'matrix', accountId: 'x' }] })).toBe(
			'matrix'
		);
	});
});

// ── needsAccountId (per-provider disambiguation rule, spec §3.2) ─────────────

describe('needsAccountId', () => {
	it('is false when the agent has only one account on the given provider', () => {
		// aria has one matrix account → no accountId needed for matrix rows
		expect(needsAccountId(MULTI_AGENT_PAYLOAD.agents[0], 'matrix')).toBe(false);
		// nova has one discord account → no accountId needed
		expect(needsAccountId(MULTI_AGENT_PAYLOAD.agents[1], 'discord')).toBe(false);
	});

	it('is true when the agent has >1 account on the given provider', () => {
		const agent = {
			name: 'dual-discord',
			accounts: [
				{ provider: 'discord', accountId: 'acc1' },
				{ provider: 'discord', accountId: 'acc2' }
			]
		};
		expect(needsAccountId(agent, 'discord')).toBe(true);
		// On a different provider it is still false
		expect(needsAccountId(agent, 'matrix')).toBe(false);
	});

	it('is false for a provider the agent has no accounts on', () => {
		// aria has no matrix-dc account
		expect(needsAccountId(MULTI_AGENT_PAYLOAD.agents[0], 'mastodon')).toBe(false);
	});
});

// ── agentAccent ──────────────────────────────────────────────────────────────

describe('agentAccent', () => {
	it('returns a CSS color string for the first two agents', () => {
		const c0 = agentAccent(0);
		const c1 = agentAccent(1);
		expect(typeof c0).toBe('string');
		expect(c0).toMatch(/^#[0-9a-f]{6}$/i);
		expect(c1).toMatch(/^#[0-9a-f]{6}$/i);
		expect(c0).not.toBe(c1);
	});

	it('wraps deterministically for indices beyond the palette size', () => {
		expect(agentAccent(0)).toBe(agentAccent(8));
		expect(agentAccent(1)).toBe(agentAccent(9));
	});
});
