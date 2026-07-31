import { describe, it, expect } from 'vitest';
import { timelineAccount, accountKey, distinctAccounts } from './timeline-key';

describe('timelineAccount', () => {
	it('splits provider and account off a discord key', () => {
		expect(timelineAccount('discord:chen:room:123456')).toEqual({
			provider: 'discord',
			accountId: 'chen'
		});
	});

	it('is unconfused by colons in a Matrix channel id', () => {
		expect(timelineAccount('matrix:main:room:!abc:example.org')).toEqual({
			provider: 'matrix',
			accountId: 'main'
		});
	});

	it('handles thread sub-timeline keys', () => {
		expect(timelineAccount('discord:bot:room:1:thread:2')).toEqual({
			provider: 'discord',
			accountId: 'bot'
		});
	});

	it('returns undefined for absent or malformed keys', () => {
		expect(timelineAccount(null)).toBeUndefined();
		expect(timelineAccount(undefined)).toBeUndefined();
		expect(timelineAccount('')).toBeUndefined();
		expect(timelineAccount('no-colons')).toBeUndefined();
		expect(timelineAccount('onlyprovider:')).toBeUndefined();
		expect(timelineAccount(':empty:provider')).toBeUndefined();
		expect(timelineAccount('a::emptyaccount')).toBeUndefined();
	});
});

describe('distinctAccounts', () => {
	it('counts unique (provider, account) pairs, ignoring unparseable keys', () => {
		expect(
			distinctAccounts([
				'matrix:main:room:!a:hs',
				'matrix:main:room:!b:hs',
				'discord:chen:room:1',
				null,
				'garbage'
			])
		).toBe(2);
	});

	it('accountKey round-trips as the grouping key', () => {
		expect(accountKey({ provider: 'discord', accountId: 'chen' })).toBe('discord:chen');
	});
});
