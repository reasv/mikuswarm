import { describe, expect, it } from 'vitest';
import {
	CONTINUATION,
	branchPath,
	buildBranchTree,
	cutAtFork,
	forkKey,
	forkPosition,
	forkSubject,
	nodeForTime,
	nodeOfToolCall,
	selectionFor,
	stepFork,
	type PathItem
} from './branches';
import type { SessionBranch } from './schemas';

// Branch reconstruction (spec REFUSAL-HANDLING §9, §12.1): stored spans are cuts
// of whatever was live at fork time; the tree tells which message each replaced.

const msg = (text: string, timestamp?: number) => ({
	role: 'assistant',
	content: [{ type: 'text', text }],
	...(timestamp !== undefined ? { timestamp } : {})
});
function branch(branchNo: number, forkIndex: number, texts: string[], over: Partial<SessionBranch> = {}): SessionBranch {
	return {
		branchNo,
		parentBranchNo: 0,
		forkIndex,
		reason: 'refusal_redo',
		checkCode: 'refusal_safety',
		decisionEvaluationId: null,
		fromModel: 'model_a',
		toModel: 'model_b',
		messages: texts.map((t) => msg(t)),
		costUsd: 0.01,
		createdAt: 0,
		...over
	};
}
/** The displayed texts, with fork markers as `[x/y]`. */
function shown(items: PathItem[]): string[] {
	return items.map((p) => {
		if (p.type === 'fork') {
			const { index, count } = forkPosition(p.fork);
			return `[${index}/${count}]`;
		}
		return (p.msg.content as Array<{ text: string }>)[0]!.text;
	});
}

// Live transcript: head (index 0) + rollout slice starting at index 1.
const live = ['a', 'b', 'c2', 'd2'].map((t) => msg(t));

describe('buildBranchTree / branchPath', () => {
	it('without branches the path is the live rollout', () => {
		const tree = buildBranchTree(live, 1, []);
		expect(shown(branchPath(tree, new Map()))).toEqual(['a', 'b', 'c2', 'd2']);
	});

	it('one fork: the switcher sits at the fork point, the latest branch is shown by default', () => {
		// Live list at fork time: [head, a, b, c1, d1]; cut at 3 → branch 1 = [c1, d1].
		const tree = buildBranchTree(live, 1, [branch(1, 3, ['c1', 'd1'])]);
		expect(tree.nodes.get(1)!.anchor).toEqual({ parent: 0, offset: 2 });
		const path = branchPath(tree, new Map());
		expect(shown(path)).toEqual(['a', 'b', '[2/2]', 'c2', 'd2']);
		const fork = path.find((p) => p.type === 'fork')!;
		expect(fork.type === 'fork' && fork.fork.options).toEqual([1, CONTINUATION]);
		// Selecting the discarded branch renders its span instead of the continuation.
		expect(shown(branchPath(tree, new Map([[forkKey(0, 2), 1]])))).toEqual(['a', 'b', '[1/2]', 'c1', 'd1']);
	});

	it('siblings at one fork point (a later rule entry refused too)', () => {
		const tree = buildBranchTree(live, 1, [branch(1, 3, ['c0']), branch(2, 3, ['c1'])]);
		expect(tree.forks.get(forkKey(0, 2))).toEqual([1, 2]);
		expect(shown(branchPath(tree, new Map()))).toEqual(['a', 'b', '[3/3]', 'c2', 'd2']);
		expect(shown(branchPath(tree, new Map([[forkKey(0, 2), 1]])))).toEqual(['a', 'b', '[1/3]', 'c0']);
		expect(shown(branchPath(tree, new Map([[forkKey(0, 2), 2]])))).toEqual(['a', 'b', '[2/3]', 'c1']);
	});

	it('a branch forked inside a span that was discarded later nests under it', () => {
		// Fork 1 at 4 (live then [h, a, b, x, y1]) stored [y1]; later fork 2 at 3
		// stored [x, y2] (x and y2 had been live), and the live list went on with c2, d2.
		const tree = buildBranchTree(live, 1, [branch(1, 4, ['y1']), branch(2, 3, ['x', 'y2'])]);
		expect(tree.nodes.get(2)!.anchor).toEqual({ parent: 0, offset: 2 });
		expect(tree.nodes.get(1)!.anchor).toEqual({ parent: 2, offset: 1 });
		const sel = selectionFor(tree, 1);
		expect(sel).toEqual(new Map([[forkKey(0, 2), 2], [forkKey(2, 1), 1]]));
		expect(shown(branchPath(tree, sel))).toEqual(['a', 'b', '[1/2]', 'x', '[1/2]', 'y1']);
		// Branch 2 shown, its own continuation (y2) by default.
		expect(shown(branchPath(tree, new Map([[forkKey(0, 2), 2]])))).toEqual(['a', 'b', '[1/2]', 'x', '[2/2]', 'y2']);
	});

	it('a sibling-edit fork: the stored span starts with the original, the live list keeps the edit', () => {
		const original = { role: 'assistant', content: [{ type: 'text', text: 'G original' }] };
		const edited = msg('G edited');
		const tree = buildBranchTree([msg('a'), edited, msg('after')], 1, [
			{ ...branch(1, 2, []), messages: [original, msg('tool result')] }
		]);
		expect(shown(branchPath(tree, new Map()))).toEqual(['a', '[2/2]', 'G edited', 'after']);
		expect(shown(branchPath(tree, new Map([[forkKey(0, 1), 1]])))).toEqual(['a', '[1/2]', 'G original', 'tool result']);
	});

	it('a fork at the end of the live list (the redo is still running)', () => {
		const tree = buildBranchTree([msg('a')], 1, [branch(1, 2, ['refused'])]);
		expect(shown(branchPath(tree, new Map()))).toEqual(['a', '[2/2]']);
	});

	it('clamps out-of-range fork indexes instead of throwing', () => {
		const tree = buildBranchTree([msg('a')], 1, [branch(1, 99, ['x']), branch(2, 0, ['y'])]);
		expect(() => branchPath(tree, new Map())).not.toThrow();
		expect(tree.nodes.get(2)!.anchor).toEqual({ parent: 0, offset: 0 });
	});
});

describe('switcher helpers', () => {
	const tree = buildBranchTree(live, 1, [branch(1, 3, ['c0'], { createdAt: 50 }), branch(2, 3, ['c1'], { createdAt: 60, reason: 'contract_redo' })]);
	const fork = branchPath(tree, new Map()).find((p) => p.type === 'fork')!;

	it('steps between options and clamps at the ends', () => {
		if (fork.type !== 'fork') throw new Error('no fork');
		expect(stepFork(fork.fork, -1)).toBe(2);
		expect(stepFork(fork.fork, 1)).toBe(CONTINUATION);
		expect(stepFork({ ...fork.fork, selected: 1 }, -1)).toBe(1);
	});

	it('the marker explains the selected branch, or the newest one under the continuation', () => {
		if (fork.type !== 'fork') throw new Error('no fork');
		expect(forkSubject(tree, fork.fork)?.branchNo).toBe(2);
		expect(forkSubject(tree, { ...fork.fork, selected: 1 })?.branchNo).toBe(1);
	});
});

describe('locating calls and timestamped records', () => {
	const stored = {
		...branch(1, 3, []),
		createdAt: 3200,
		messages: [
			{ role: 'assistant', content: [{ type: 'toolCall', id: 'call-r', name: 'send_message', arguments: {} }], timestamp: 3000 }
		]
	};
	const tree = buildBranchTree([msg('a', 2000), msg('b', 4000)], 1, [stored]);

	it('finds the branch holding a tool call', () => {
		expect(nodeOfToolCall(tree, 'call-r')).toBe(1);
		expect(nodeOfToolCall(tree, 'nope')).toBeUndefined();
	});

	it('assigns a record to the stored branch whose time span covers it, else live', () => {
		expect(nodeForTime(tree, 3100)).toBe(1);
		expect(nodeForTime(tree, 3300)).toBe(0);
		expect(nodeForTime(tree, 1500)).toBe(0);
		expect(nodeForTime(tree, 1500, 1)).toBe(1); // an explicit re-anchored branch wins
	});

	it('cuts a live slice at an absolute fork index', () => {
		expect(cutAtFork(['a', 'b', 'c'], 1, 3)).toEqual(['a', 'b']);
		expect(cutAtFork(['a'], 2, 1)).toEqual([]);
	});
});

// Late input (ARCHITECTURE.md §8): an edit / addition redo forks at index 0 (the
// whole old rollout, kickoff included); a revival at the record turn start; an
// aborted turn at the aborted message.
describe('late-input branches', () => {
	const kick = (text: string) => ({ type: 'triggerGroup', role: 'user', content: text });
	const text = (p: PathItem): string =>
		p.type === 'fork'
			? `[${forkPosition(p.fork).index}/${forkPosition(p.fork).count}]`
			: typeof p.msg.content === 'string'
				? p.msg.content
				: (p.msg.content as Array<{ text: string }>)[0]!.text;
	const late = (no: number, forkIndex: number, reason: string, span: unknown[]): SessionBranch =>
		branch(no, forkIndex, [], { reason, messages: span as SessionBranch['messages'], checkCode: null });

	it('a fork-0 redo is an alternative at the start of the live rollout, kickoff included', () => {
		// Live: head [kickoff 7pm] + rollout [x, y]; branch 1 = the 6pm run.
		const tree = buildBranchTree([msg('x'), msg('y')], 1, [late(1, 0, 'edit_redo', [kick('6pm'), msg('old')])]);
		expect(tree.nodes.get(1)!.anchor).toEqual({ parent: 0, offset: 0 });
		expect(branchPath(tree, new Map()).map(text)).toEqual(['[2/2]', 'x', 'y']);
		expect(branchPath(tree, new Map([[forkKey(0, 0), 1]])).map(text)).toEqual(['[1/2]', '6pm', 'old']);
	});

	it('two fork-0 redos are siblings; an older fork inside a redone run nests under it', () => {
		const tree = buildBranchTree([msg('live')], 1, [
			late(1, 2, 'refusal_redo', [msg('refused')]),
			late(2, 0, 'edit_redo', [kick('6pm'), msg('a'), msg('redone')]),
			late(3, 0, 'addition_redo', [kick('7pm'), msg('b')])
		]);
		expect(tree.forks.get(forkKey(0, 0))).toEqual([2, 3]);
		// Branch 1 forked the 6pm run at absolute index 2: inside branch 2's span.
		expect(tree.nodes.get(1)!.anchor).toEqual({ parent: 2, offset: 2 });
		const sel = selectionFor(tree, 1);
		expect(branchPath(tree, sel).map(text)).toEqual(['[1/3]', '6pm', 'a', '[1/2]', 'refused']);
	});

	it('a revival forks at the record turn start; an aborted turn at its message', () => {
		const live = [msg('send'), msg('interjection'), msg('reply')];
		const tree = buildBranchTree(live, 1, [
			late(1, 2, 'turn_aborted', [msg('partial')]),
			late(2, 3, 'revival', [msg('record prompt'), msg('record call')])
		]);
		expect(tree.nodes.get(1)!.anchor).toEqual({ parent: 0, offset: 1 });
		expect(tree.nodes.get(2)!.anchor).toEqual({ parent: 0, offset: 2 });
		expect(branchPath(tree, new Map([[forkKey(0, 2), 2]])).map(text)).toEqual([
			'send',
			'[2/2]',
			'interjection',
			'[1/2]',
			'record prompt',
			'record call'
		]);
	});
});
