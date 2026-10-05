import { render } from 'vitest-browser-svelte';
import { page } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import LiveRollout from './LiveRollout.svelte';

// The live rollout follows `branch_forked` (spec REFUSAL-HANDLING §12.1): the
// discarded tail disappears at once, the parent is told (it refetches the session
// for the new switcher), and the server's re-seed carries the new live branch.
const head = { type: 'triggerGroup', role: 'user', content: 'hi' };
const say = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });

let emitter: ((evt: { type: string; [k: string]: unknown }) => void) | undefined;
const emit = (evt: { type: string; [k: string]: unknown }) => emitter!(evt);
vi.mock('$lib/api/live', () => ({
	consumeSessionStream: (_id: string, opts: { onEvent: (evt: { type: string }) => void }) => {
		emitter = opts.onEvent as typeof emitter;
		return new Promise(() => {});
	}
}));

test('branch_forked cuts the live list and the re-seed shows the redo', async () => {
	const onBranchForked = vi.fn();
	render(LiveRollout, { sessionId: 's-live', onBranchForked });
	await vi.waitFor(() => expect(emitter).toBeTypeOf('function'));
	emit({ type: 'rollout_seed', messages: [head, say('kept'), say('refused text')], rolloutStartIndex: 1 });
	await expect.element(page.getByText('refused text')).toBeInTheDocument();

	emit({ type: 'branch_forked', branchNo: 1, forkIndex: 2, reason: 'refusal_redo', fromModel: 'model_a', toModel: 'model_b' });
	await expect.element(page.getByText('kept')).toBeInTheDocument();
	expect(page.getByText('refused text').elements()).toHaveLength(0);
	expect(onBranchForked).toHaveBeenCalledOnce();

	emit({ type: 'rollout_seed', messages: [head, say('kept'), say('redone on model_b')], rolloutStartIndex: 1 });
	await expect.element(page.getByText('redone on model_b')).toBeInTheDocument();
});
