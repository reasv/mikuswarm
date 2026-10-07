import { describe, expect, it } from 'vitest';
import {
	branchReasonDetail,
	branchReasonLabel,
	causeSender,
	holdLabel,
	holdOf,
	interjectionKindLabel,
	interjectionKindOf,
	interjectionTagReason,
	isEstimated
} from './late-input';
import type { SessionInterjection } from './schemas';

describe('branch reasons', () => {
	it('labels every reason, unknown ones as their words', () => {
		expect(branchReasonLabel('edit_redo')).toBe('Redone after edit');
		expect(branchReasonLabel('addition_redo')).toBe('Redone after addition');
		expect(branchReasonLabel('revival')).toBe('Revived');
		expect(branchReasonLabel('turn_aborted')).toBe('Turn aborted for interjection');
		expect(branchReasonLabel('refusal_redo')).toBe('Refusal redo');
		expect(branchReasonLabel('contract_redo')).toBe('Send-contract redo');
		expect(branchReasonLabel('some_new_reason')).toBe('some new reason');
		expect(branchReasonLabel(null)).toBe('Redo');
	});

	it('explains the late-input reasons only', () => {
		expect(branchReasonDetail('edit_redo')).toMatch(/edited/);
		expect(branchReasonDetail('revival')).toMatch(/record turn/);
		expect(branchReasonDetail('refusal_redo')).toBeNull();
	});

	it('names the cause sender by display name, else id', () => {
		const cause = { eventId: 'e', senderId: '@a:x', senderName: null, body: 'b', timestamp: 1, editedAt: null };
		expect(causeSender(cause)).toBe('@a:x');
		expect(causeSender({ ...cause, senderName: 'Ada' })).toBe('Ada');
	});
});

describe('interjection kinds', () => {
	const row = (kind: string, body: string): SessionInterjection => ({
		eventId: null,
		externalId: null,
		senderId: null,
		senderName: null,
		kind,
		body,
		createdAt: 0
	});

	it('labels kinds', () => {
		expect(interjectionKindLabel('edit')).toBe('trigger edited');
		expect(interjectionKindLabel('revival')).toBe('revival');
		expect(interjectionKindLabel('addition')).toBe('late addition');
		expect(interjectionKindLabel('co-reply')).toBe('co-reply');
		expect(interjectionKindLabel('follow-up-media')).toBe('follow-up (media)');
	});

	it('reads the tag reason', () => {
		expect(interjectionTagReason('<interjection reason="co-reply">\nhi')).toBe('co-reply');
		expect(interjectionTagReason('plain')).toBeNull();
	});

	it('resolves a message by its row body, else its tag, never a non-interjection', () => {
		const rows = [row('revival', 'is it still on?'), row('addition', '')];
		expect(interjectionKindOf({ type: 'interjection', content: '<message from="G">is it still on?</message>' }, rows)).toBe(
			'revival'
		);
		expect(interjectionKindOf({ type: 'interjection', content: '<interjection reason="edit">x' }, rows)).toBe('edit');
		expect(interjectionKindOf({ type: 'interjection', content: 'untagged' }, rows)).toBeNull();
		expect(interjectionKindOf({ role: 'user', content: 'is it still on?' }, rows)).toBeNull();
	});
});

describe('irreversibility hold and estimated usage', () => {
	it('reads the hold off a tool result', () => {
		expect(holdOf({ role: 'toolResult', lateInputHold: { heldMs: 3200, reason: 'hold_deadline' } })).toEqual({
			heldMs: 3200,
			reason: 'hold_deadline'
		});
		expect(holdOf({ role: 'toolResult' })).toBeNull();
		expect(holdOf({ role: 'toolResult', lateInputHold: { reason: 'x' } })).toBeNull();
		expect(holdOf(undefined)).toBeNull();
	});

	it('words the hold', () => {
		expect(holdLabel({ heldMs: 3200, reason: 'hold_deadline' })).toBe('held 3.2 s, waiting for corrections');
		expect(holdLabel({ heldMs: 450, reason: 'verdict_pending' })).toBe('held 450 ms, waiting for a late-addition verdict');
		expect(holdLabel({ heldMs: 1400, reason: 'correction' })).toBe('held 1.4 s, a correction arrived');
	});

	it('treats 1 and true as estimated', () => {
		expect(isEstimated(1)).toBe(true);
		expect(isEstimated(true)).toBe(true);
		expect(isEstimated(null)).toBe(false);
		expect(isEstimated(undefined)).toBe(false);
		expect(isEstimated(0)).toBe(false);
	});
});
