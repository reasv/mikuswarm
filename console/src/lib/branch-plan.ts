import type {
	ContractAttempt,
	DecisionEvaluation,
	RefusalEvent,
	SessionAudit,
	SessionBranch,
	SessionContract
} from '$lib/schemas';
import {
	branchPath,
	forkSubject,
	nodeForTime,
	type BranchTree,
	type ForkPoint
} from '$lib/branches';
import {
	assistantBlocks,
	buildRolloutPlan,
	collectToolResults,
	type RolloutMsg
} from '$lib/rollout';
import {
	assistantTextOf,
	attemptBeforeNudge,
	auditFindings,
	isPostingTool,
	nudgeOf,
	postedTextOf,
	type AuditFinding,
	type GateEvaluation
} from '$lib/checks';

/**
 * The rollout's render plan with branches and checks (spec REFUSAL-HANDLING
 * §12.1–§12.2): the displayed branch path, interleaved with the routing and
 * records decision cards (as before), fork markers with their switchers, hard
 * refusal markers on the request they hit, and ending verdicts that have no
 * tool call (a `NO_REPLY` text ending, forced-completion exhaustion). Gate and
 * `no_reply` ending cards attach to their tool call in the message renderer.
 */

export interface NudgeInfo {
	/** 1-based nudge number. */
	index: number;
	/** The nudge budget, when known. */
	of: number | null;
	variant: string;
	/** The attempt this nudge closed (its failure types). */
	attempt?: ContractAttempt;
	/** Recovered: the first attempted text and the message finally sent. */
	recovery?: { first: string; sent: string };
	/** Offline audit findings for this attempt, when the audit has run. */
	audit: AuditFinding[];
}

export interface ForkInfo {
	fork: ForkPoint;
	/** The branch row the marker explains (see `forkSubject`). */
	subject: SessionBranch | null;
	/** The refusal event behind a refusal redo (probability, rule). */
	refusal: RefusalEvent | null;
	/** Nudges in the discarded span (contract redo: "3 nudges without a send"). */
	nudges: number;
}

export type BranchPlanItem =
	| { type: 'message'; key: string; node: number; offset: number; msg: RolloutMsg; nudge?: NudgeInfo }
	| {
			type: 'decision';
			key: string;
			decisionGroup: string;
			evaluations: DecisionEvaluation[];
			injected?: string[];
	  }
	| { type: 'fork'; key: string; info: ForkInfo }
	| { type: 'hard_refusal'; key: string; event: RefusalEvent }
	| { type: 'ending'; key: string; node: number; evaluation: GateEvaluation };

export interface BranchPlanInput {
	tree: BranchTree;
	selection: ReadonlyMap<string, number>;
	/** Every decision row of the session (routing/records cards are planned here). */
	evaluations: readonly DecisionEvaluation[];
	gate: readonly GateEvaluation[];
	refusalEvents: readonly RefusalEvent[];
	contract?: SessionContract;
	/** The offline audit's rows (`session_audits`), when it has run. */
	audits?: readonly SessionAudit[];
}

/** Points rendered as their own cards elsewhere, never as decision cards. */
const NON_DECISION_POINTS = new Set(['checks', 'audit']);

const isRunStart = (m: RolloutMsg): boolean => m.type === 'triggerGroup' || m.type === 'satellite';

export function buildBranchPlan(input: BranchPlanInput): BranchPlanItem[] {
	const { tree } = input;
	const path = branchPath(tree, input.selection);
	const msgs = path.flatMap((p) => (p.type === 'message' ? [p] : []));

	// Routing/records decision cards, placed over the displayed messages as before.
	const decisionRows = input.evaluations.filter((e) => !NON_DECISION_POINTS.has(e.point));
	const base = buildRolloutPlan(
		msgs.map((m) => m.msg),
		decisionRows
	);
	const decisionsBefore = new Map<number, BranchPlanItem[]>();
	let pending: BranchPlanItem[] = [];
	for (const item of base) {
		if (item.type === 'decision') {
			pending.push({ ...item, key: `decision:${item.decisionGroup}` });
		} else {
			decisionsBefore.set(item.index, pending);
			pending = [];
		}
	}
	const trailingDecisions = pending;

	// Timestamped records: hard refusals go before the request they hit (the
	// first assistant message of their branch at or after them); ending verdicts
	// without a tool call after the ending they judged.
	const before = new Map<number, BranchPlanItem[]>();
	const after = new Map<number, BranchPlanItem[]>();
	const add = (map: Map<number, BranchPlanItem[]>, i: number, item: BranchPlanItem) =>
		map.set(i, [...(map.get(i) ?? []), item]);
	const indicesOf = (node: number) => msgs.flatMap((m, i) => (m.node === node ? [i] : []));
	const ts = (i: number) => (typeof msgs[i]!.msg.timestamp === 'number' ? (msgs[i]!.msg.timestamp as number) : null);
	const isAssistant = (i: number) => msgs[i]!.msg.role === 'assistant';

	for (const event of input.refusalEvents) {
		if (event.checkpoint !== 'request') continue;
		const node = nodeForTime(tree, event.ts, event.branchNo);
		const idx = indicesOf(node);
		if (idx.length === 0) continue;
		const item: BranchPlanItem = { type: 'hard_refusal', key: `refusal:${event.id}`, event };
		const at = idx.find((i) => isAssistant(i) && (ts(i) ?? Infinity) >= event.ts);
		// No later request in its branch: the refusal ended it (terminal, or withheld).
		if (at !== undefined) add(before, at, item);
		else add(after, idx.at(-1)!, item);
	}
	for (const evaluation of input.gate) {
		if (evaluation.toolCallId || evaluation.checkpoint !== 'ending') continue;
		const node = nodeForTime(tree, evaluation.ts, evaluation.branchNo);
		const idx = indicesOf(node);
		if (idx.length === 0) continue;
		const item: BranchPlanItem = { type: 'ending', key: `ending:${evaluation.decisionGroup}`, node, evaluation };
		const ending = [...idx].reverse().find((i) => isAssistant(i) && (ts(i) ?? -Infinity) <= evaluation.ts);
		if (ending !== undefined) add(after, ending, item);
		else add(before, idx[0]!, item);
	}

	// Nudges: numbered by their marker, else counted since the run start or fork.
	const contract = input.contract;
	const audits = auditFindings(input.audits ?? []);
	const nudges = new Map<number, NudgeInfo>();
	let count = 0;
	let group: number[] = [];
	const closeGroup = (end: number) => {
		if (group.length === 0) return;
		const last = group.at(-1)!;
		const sent = sentAfter(msgs.map((m) => m.msg), last, end);
		const first = firstAttemptBefore(msgs.map((m) => m.msg), group[0]!);
		if (sent && first) nudges.get(last)!.recovery = { first, sent };
		group = [];
	};
	let msgIndex = 0;
	for (const p of path) {
		if (p.type === 'fork') {
			closeGroup(msgIndex);
			count = 0;
			continue;
		}
		const i = msgIndex++;
		if (isRunStart(p.msg)) {
			closeGroup(i);
			count = 0;
			continue;
		}
		const nudge = nudgeOf(p.msg);
		if (!nudge) continue;
		count = nudge.attempt ?? count + 1;
		const info: NudgeInfo = {
			index: count,
			of: contract?.maxNudges ?? null,
			variant: nudge.variant,
			attempt: attemptBeforeNudge(
				contract?.attempts ?? [],
				p.node,
				count,
				typeof p.msg.timestamp === 'number' ? p.msg.timestamp : undefined
			),
			audit: []
		};
		const attempt = info.attempt;
		info.audit = audits.filter(
			(a) =>
				a.attemptNo === count - 1 &&
				a.branchNo === (attempt?.branchNo ?? p.node) &&
				(attempt === undefined || a.redoNo === attempt.redoNo)
		);
		nudges.set(i, info);
		group.push(i);
	}
	closeGroup(msgs.length);

	const out: BranchPlanItem[] = [];
	msgIndex = 0;
	for (const p of path) {
		if (p.type === 'fork') {
			out.push({ type: 'fork', key: `fork:${p.fork.key}`, info: forkInfo(input, p.fork) });
			continue;
		}
		const i = msgIndex++;
		out.push(...(decisionsBefore.get(i) ?? []), ...(before.get(i) ?? []));
		out.push({
			type: 'message',
			key: `m:${p.node}:${p.offset}`,
			node: p.node,
			offset: p.offset,
			msg: p.msg,
			...(nudges.has(i) ? { nudge: nudges.get(i) } : {})
		});
		out.push(...(after.get(i) ?? []));
	}
	if (msgs.length === 0) out.unshift(...trailingDecisions);
	else out.push(...trailingDecisions);
	return out;
}

function forkInfo(input: BranchPlanInput, fork: ForkPoint): ForkInfo {
	const subject = forkSubject(input.tree, fork);
	let refusal: RefusalEvent | null = null;
	if (subject?.reason === 'refusal_redo') {
		refusal =
			input.refusalEvents.find(
				(e) => subject.decisionEvaluationId != null && e.decisionEvaluationId === subject.decisionEvaluationId
			) ??
			[...input.refusalEvents]
				.filter((e) => e.outcome === 'redo' && e.checkCode === subject.checkCode && e.ts <= subject.createdAt)
				.at(-1) ??
			null;
	}
	const nudges = subject
		? (input.tree.nodes.get(subject.branchNo)?.messages ?? []).filter((m) => nudgeOf(m) !== null).length
		: 0;
	return { fork, subject, refusal, nudges };
}

/** The first message a posting call delivered after `from` (before `end` or the next nudge). */
function sentAfter(msgs: readonly RolloutMsg[], from: number, end: number): string | null {
	const results = collectToolResults(msgs);
	for (let i = from + 1; i < end; i++) {
		const m = msgs[i]!;
		if (nudgeOf(m) || isRunStart(m)) return null;
		if (m.role !== 'assistant') continue;
		for (const b of assistantBlocks(m.content)) {
			if (b.type !== 'toolCall' || !isPostingTool(b.name)) continue;
			if (results.get(b.id)?.isError === true) continue;
			const text = postedTextOf(b.arguments);
			if (text) return text;
		}
	}
	return null;
}

/** The text the model wrote before the first nudge of a group (its first attempt). */
function firstAttemptBefore(msgs: readonly RolloutMsg[], nudge: number): string | null {
	for (let i = nudge - 1; i >= 0; i--) {
		const m = msgs[i]!;
		if (isRunStart(m)) return null;
		if (m.role !== 'assistant') continue;
		const text = assistantTextOf(m);
		if (text) return text;
	}
	return null;
}
