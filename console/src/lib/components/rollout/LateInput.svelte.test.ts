import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { expect, test } from 'vitest';
import ForkMarker from './ForkMarker.svelte';
import ToolCallCard from './ToolCallCard.svelte';
import InterjectionCard from './InterjectionCard.svelte';
import { CONTINUATION } from '$lib/branches';
import type { SessionBranch } from '$lib/schemas';

// Late input in the rollout (ARCHITECTURE.md §8 "Late input", §11).
const subject: SessionBranch = {
	branchNo: 1,
	parentBranchNo: 0,
	forkIndex: 0,
	reason: 'edit_redo',
	checkCode: null,
	decisionEvaluationId: null,
	fromModel: null,
	toModel: null,
	messages: [],
	costUsd: 0.001,
	createdAt: 1,
	causeEventId: 'matrix:a:$t',
	cause: { eventId: 'matrix:a:$t', senderId: '@ada:x', senderName: 'Ada', body: 'it is at 7:30pm', timestamp: 1, editedAt: 5 }
};
const fork = { key: '0:0', parent: 0, offset: 0, options: [1, CONTINUATION], selected: CONTINUATION };

test('the switcher names the reason and the causing message, marked edited', async () => {
	render(ForkMarker, { info: { fork, subject, refusal: null, nudges: 0 }, onSelect: () => {} });
	await expect.element(page.getByText('Redone after edit')).toBeInTheDocument();
	await expect.element(page.getByTestId('fork-cause')).toHaveTextContent('Ada:');
	await expect.element(page.getByTestId('fork-cause')).toHaveTextContent('it is at 7:30pm');
	await expect.element(page.getByTestId('fork-cause-edited')).toBeInTheDocument();
});

test('an aborted turn has no cause line', async () => {
	const aborted = { ...subject, reason: 'turn_aborted', causeEventId: null, cause: null };
	const { container } = render(ForkMarker, { info: { fork, subject: aborted, refusal: null, nudges: 0 }, onSelect: () => {} });
	await expect.element(page.getByText('Turn aborted for interjection')).toBeInTheDocument();
	expect(container.querySelector('[data-testid="fork-cause"]')).toBeNull();
});

test('a held call shows its hold; a correction-cancelled one in a discarded branch says so', async () => {
	render(ToolCallCard, {
		name: 'send_message',
		args: {},
		result: { role: 'toolResult', content: 'sent', lateInputHold: { heldMs: 3200, reason: 'hold_deadline' } }
	});
	await expect.element(page.getByText('held 3.2 s, waiting for corrections')).toBeInTheDocument();
	render(ToolCallCard, {
		name: 'send_message',
		args: {},
		discarded: true,
		result: { role: 'toolResult', content: 'not sent', lateInputHold: { heldMs: 1400, reason: 'correction' } }
	});
	await expect.element(page.getByText('held 1.4 s, a correction arrived · cancelled')).toBeInTheDocument();
});

test('an interjection card shows its kind', async () => {
	render(InterjectionCard, { text: 'is it still on?', kind: 'revival' });
	await expect.element(page.getByTestId('interjection-kind')).toHaveTextContent('revival');
});
