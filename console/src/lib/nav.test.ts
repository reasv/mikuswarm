import { describe, it, expect } from 'vitest';
import { conversationsHref, pipelinesHref } from './nav';

describe('conversationsHref', () => {
	it('omits the query entirely when nothing is selected', () => {
		expect(conversationsHref({})).toBe('/');
		expect(conversationsHref({ room: null, session: null })).toBe('/');
	});

	it('encodes a room-only selection (room view)', () => {
		expect(conversationsHref({ room: '!abc:server' })).toBe('/?room=%21abc%3Aserver');
	});

	it('carries room + session for a drill-down', () => {
		expect(conversationsHref({ room: 'r', session: 's' })).toBe('/?room=r&session=s');
	});

	it('drops the room from a room link so clicking a room returns to room view', () => {
		// A room link never carries `session` — this is what fixes the "clicking the
		// room while a session is open does nothing" bug.
		expect(conversationsHref({ room: 'r' })).toBe('/?room=r');
	});

	it('allows a session-only deep link (e.g. the scheduler waiter links)', () => {
		expect(conversationsHref({ session: 's' })).toBe('/?session=s');
	});

	it('encodes the agent tab selection (spec CONSOLE-MULTI-AGENT §3.5)', () => {
		expect(conversationsHref({ agent: 'aria' })).toBe('/?agent=aria');
	});

	it('carries agent + room together for an agent-filtered room view', () => {
		expect(conversationsHref({ agent: 'nova', room: 'discord:nova:room:1002' })).toBe(
			'/?agent=nova&room=discord%3Anova%3Aroom%3A1002'
		);
	});

	it('drops a null/empty agent (clears the filter)', () => {
		expect(conversationsHref({ agent: null, room: 'r' })).toBe('/?room=r');
		expect(conversationsHref({ agent: '' })).toBe('/');
	});
});

describe('pipelinesHref', () => {
	it('omits the query when nothing is selected', () => {
		expect(pipelinesHref({})).toBe('/pipelines');
	});

	it('encodes a pool-only selection', () => {
		expect(pipelinesHref({ pool: 'enrichment' })).toBe('/pipelines?pool=enrichment');
	});

	it('preserves filters when selecting an item', () => {
		expect(pipelinesHref({ pool: 'captioning', status: 'failed', item: 'x' })).toBe(
			'/pipelines?pool=captioning&status=failed&item=x'
		);
	});

	it('drops empty/null params (a cleared filter)', () => {
		expect(pipelinesHref({ pool: 'diary', status: null, room: '', item: 'i' })).toBe(
			'/pipelines?pool=diary&item=i'
		);
	});
});
