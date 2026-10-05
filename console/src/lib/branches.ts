import type { SessionBranch } from '$lib/schemas';
import { asMsg, type RolloutMsg } from '$lib/rollout';

/**
 * Session branches in the rollout (spec REFUSAL-HANDLING §9, §12.1), like
 * conversation branches in chat interfaces.
 *
 * The live transcript is branch 0. A redo forked the live list at `forkIndex`
 * and stored the discarded tail as branch n (`agent_session_branches`), so the
 * stored spans are chronological cuts of whatever was live at the time. Walking
 * them newest first rebuilds every earlier live list (the same reconstruction
 * as the agent's send-contract derivation), which tells, for every branch, the
 * message it was the alternative to: the first message that replaced it, in
 * whichever branch that message finally landed. That gives a tree: each node
 * is a message sequence, and each fork point (`parent`, `offset`) holds the
 * stored branches forked there plus the parent's own continuation (the newest
 * alternative). Several branches can share a fork point (a later rule entry
 * refused too); a sibling-edit fork's span starts with the original assistant
 * message while the continuation holds the edited one, so the two are simply
 * alternatives at that point. A branch forked inside a span that was itself
 * discarded later nests under that span.
 */

/** Branch number of the live transcript. */
export const LIVE_BRANCH = 0;
/** The fork option that follows the parent's own continuation (the newest alternative). */
export const CONTINUATION = -1;

export interface BranchNode {
	branchNo: number;
	/** The node's messages: the live rollout slice, or the stored span. */
	messages: RolloutMsg[];
	/** The stored branch row; null for the live branch. */
	branch: SessionBranch | null;
	/** Where the branch was forked: the node and offset of the message it replaced. */
	anchor: { parent: number; offset: number } | null;
}

export interface BranchTree {
	nodes: Map<number, BranchNode>;
	/** `forkKey(parent, offset)` → stored branch numbers forked there, oldest first. */
	forks: Map<string, number[]>;
}

export function forkKey(parent: number, offset: number): string {
	return `${parent}:${offset}`;
}

/**
 * Build the branch tree. `live` is the live rollout slice and `liveStart` its
 * index in the full live message list (`rolloutStartIndex`): stored fork
 * indexes are absolute, live offsets are relative to the slice.
 */
export function buildBranchTree(
	live: readonly unknown[],
	liveStart: number,
	branches: readonly SessionBranch[]
): BranchTree {
	const nodes = new Map<number, BranchNode>();
	nodes.set(LIVE_BRANCH, {
		branchNo: LIVE_BRANCH,
		messages: live.map(asMsg),
		branch: null,
		anchor: null
	});
	// The live list as (node, offset) entries; the head before the rollout slice
	// gets negative offsets (forks never cut there: the fork floor is after the
	// run start).
	let list: Array<{ node: number; offset: number }> = [];
	for (let i = 0; i < liveStart + live.length; i++) list.push({ node: LIVE_BRANCH, offset: i - liveStart });

	const forks = new Map<string, number[]>();
	const newestFirst = [...branches].sort((a, b) => b.branchNo - a.branchNo);
	for (const b of newestFirst) {
		if (b.branchNo === LIVE_BRANCH || nodes.has(b.branchNo)) continue;
		const k = Math.max(0, Math.min(b.forkIndex, list.length));
		let anchor: { parent: number; offset: number };
		if (k < list.length) anchor = { parent: list[k]!.node, offset: list[k]!.offset };
		else if (k > 0) anchor = { parent: list[k - 1]!.node, offset: list[k - 1]!.offset + 1 };
		else anchor = { parent: LIVE_BRANCH, offset: 0 };
		if (anchor.offset < 0) anchor = { parent: anchor.parent, offset: 0 };
		// Replaced by the first message of a later stored span: that span was cut at
		// the same point, so the two are siblings there, not nested.
		for (let up = nodes.get(anchor.parent); anchor.offset === 0 && up?.anchor; up = nodes.get(anchor.parent)) {
			anchor = up.anchor;
		}
		const messages = b.messages.map(asMsg);
		nodes.set(b.branchNo, { branchNo: b.branchNo, messages, branch: b, anchor });
		const key = forkKey(anchor.parent, anchor.offset);
		forks.set(key, [...(forks.get(key) ?? []), b.branchNo]);
		list = [...list.slice(0, k), ...messages.map((_, j) => ({ node: b.branchNo, offset: j }))];
	}
	for (const opts of forks.values()) opts.sort((a, b) => a - b);
	return { nodes, forks };
}

/** One fork point on the displayed path. */
export interface ForkPoint {
	key: string;
	parent: number;
	offset: number;
	/** Stored branches forked here oldest first, then {@link CONTINUATION}. */
	options: number[];
	/** The option shown (an entry of `options`). */
	selected: number;
}

export type PathItem =
	| { type: 'message'; node: number; offset: number; msg: RolloutMsg }
	| { type: 'fork'; fork: ForkPoint };

/**
 * The displayed path: the live branch from its start, switching into the
 * selected branch at each fork point. `selection` maps a fork key to the chosen
 * option; a fork with no entry shows the continuation (the latest branch, spec
 * §12.1). A selected branch is followed from its first message, with its own
 * nested forks.
 */
export function branchPath(tree: BranchTree, selection: ReadonlyMap<string, number>): PathItem[] {
	const out: PathItem[] = [];
	let node = tree.nodes.get(LIVE_BRANCH);
	let start = 0;
	const seen = new Set<number>();
	while (node && !seen.has(node.branchNo)) {
		seen.add(node.branchNo);
		let next: BranchNode | undefined;
		for (let offset = start; offset <= node.messages.length; offset++) {
			const key = forkKey(node.branchNo, offset);
			const stored = tree.forks.get(key);
			if (stored) {
				const options = [...stored, CONTINUATION];
				const wanted = selection.get(key);
				const selected = wanted !== undefined && options.includes(wanted) ? wanted : CONTINUATION;
				out.push({ type: 'fork', fork: { key, parent: node.branchNo, offset, options, selected } });
				if (selected !== CONTINUATION) {
					next = tree.nodes.get(selected);
					break;
				}
			}
			if (offset < node.messages.length) {
				out.push({ type: 'message', node: node.branchNo, offset, msg: node.messages[offset]! });
			}
		}
		node = next;
		start = 0;
	}
	return out;
}

/** The fork selections that display `branchNo` (every ancestor fork set on the way). */
export function selectionFor(tree: BranchTree, branchNo: number): Map<string, number> {
	const out = new Map<string, number>();
	let node = tree.nodes.get(branchNo);
	const seen = new Set<number>();
	while (node?.anchor && !seen.has(node.branchNo)) {
		seen.add(node.branchNo);
		out.set(forkKey(node.anchor.parent, node.anchor.offset), node.branchNo);
		node = tree.nodes.get(node.anchor.parent);
	}
	return out;
}

/** The node holding the assistant message that made tool call `toolCallId` (stored spans first). */
export function nodeOfToolCall(tree: BranchTree, toolCallId: string): number | undefined {
	const order = [...tree.nodes.keys()].sort((a, b) => b - a);
	for (const no of order) {
		for (const m of tree.nodes.get(no)!.messages) {
			if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
			for (const b of m.content as Array<{ type?: string; id?: string }>) {
				if (b?.type === 'toolCall' && b.id === toolCallId) return no;
			}
		}
	}
	return undefined;
}

/**
 * The node a timestamped record (refusal event, ending verdict) belongs to:
 * `branchNo` when it names a stored branch (rows re-anchored after a fork),
 * else the innermost stored branch whose time span (first message → fork)
 * covers `ts`, else the live branch.
 */
export function nodeForTime(tree: BranchTree, ts: number, branchNo?: number | null): number {
	if (branchNo != null && branchNo !== LIVE_BRANCH && tree.nodes.has(branchNo)) return branchNo;
	let best: { no: number; start: number } | null = null;
	for (const node of tree.nodes.values()) {
		if (!node.branch) continue;
		const stamps = node.messages.map((m) => m.timestamp).filter((t): t is number => typeof t === 'number');
		if (stamps.length === 0) continue;
		const start = Math.min(...stamps);
		if (ts >= start && ts <= node.branch.createdAt && (!best || start > best.start)) {
			best = { no: node.branchNo, start };
		}
	}
	return best?.no ?? LIVE_BRANCH;
}

/** "‹ 2/3 ›": the 1-based position of the selected option. */
export function forkPosition(fork: ForkPoint): { index: number; count: number } {
	return { index: fork.options.indexOf(fork.selected) + 1, count: fork.options.length };
}

/** The option `step` places away from the selected one (clamped). */
export function stepFork(fork: ForkPoint, step: number): number {
	const i = fork.options.indexOf(fork.selected);
	const j = Math.max(0, Math.min(fork.options.length - 1, i + step));
	return fork.options[j]!;
}

/**
 * The branch row a fork marker explains: the selected stored branch, or with
 * the continuation shown, the newest branch forked there (the one the
 * continuation redid).
 */
export function forkSubject(tree: BranchTree, fork: ForkPoint): SessionBranch | null {
	const no =
		fork.selected !== CONTINUATION
			? fork.selected
			: fork.options.filter((o) => o !== CONTINUATION).at(-1);
	return no === undefined ? null : (tree.nodes.get(no)?.branch ?? null);
}

/** Apply a `branch_forked` live event to a live rollout slice: cut at the fork. */
export function cutAtFork<T>(messages: readonly T[], liveStart: number, forkIndex: number): T[] {
	return messages.slice(0, Math.max(0, forkIndex - liveStart));
}
