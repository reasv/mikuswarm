import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import { buildBranchPlan, type BranchPlanItem } from './branch-plan';
import { buildBranchTree, forkKey } from './branches';
import { gateEvaluations } from './checks';
import type { RolloutMsg } from './rollout';
import { SessionDecisionsResponse, SessionDetailResponse, type DecisionEvaluation } from './schemas';
import fixture from '$lib/server/api/demo/refusal-session.json';
import demoDecisionRows from '$lib/server/api/demo/decision-evaluations.json';

// The rollout plan with branches and checks over the generated demo session:
// a hard refusal on the first request, a send judged a soft refusal and redone
// (branch 1), a text-only ending, one nudge, and the send.
const detail = Schema.decodeUnknownSync(SessionDetailResponse)(fixture.detail);
const rows = [...Schema.decodeUnknownSync(SessionDecisionsResponse)(fixture.decisions).evaluations];
const live = detail.transcript.slice(detail.rolloutStartIndex);
const tree = buildBranchTree(live, detail.rolloutStartIndex, detail.branches ?? []);

function plan(selection = new Map<string, number>(), evaluations: DecisionEvaluation[] = rows): BranchPlanItem[] {
	return buildBranchPlan({
		tree,
		selection,
		evaluations,
		gate: gateEvaluations(evaluations, detail.checks),
		refusalEvents: detail.refusalEvents ?? [],
		contract: detail.contract
	});
}

function describeItem(item: BranchPlanItem): string {
	switch (item.type) {
		case 'message': {
			const m = item.msg as RolloutMsg;
			if (item.nudge) return `nudge ${item.nudge.index}`;
			if (m.role === 'toolResult') return `result ${m.toolCallId}`;
			const blocks = (m.content as Array<{ type: string; id?: string; text?: string }>) ?? [];
			return blocks.map((b) => (b.type === 'toolCall' ? `call ${b.id}` : `text`)).join(',');
		}
		case 'fork':
			return `fork ${item.info.fork.selected}`;
		case 'hard_refusal':
			return `hard ${item.event.checkCode}`;
		case 'ending':
			return 'ending';
		case 'decision':
			return `decision ${item.decisionGroup}`;
	}
}

describe('buildBranchPlan', () => {
	it('live view: hard refusal before the request it hit, the fork, the nudge', () => {
		expect(plan().map(describeItem)).toEqual([
			'hard refusal_safety',
			'call call-search',
			'result call-search',
			'fork -1',
			'text',
			'nudge 1',
			'call call-sent',
			'result call-sent'
		]);
	});

	it('the fork marker explains the refusal redo: check, probability, rule target', () => {
		const fork = plan().find((i) => i.type === 'fork');
		if (fork?.type !== 'fork') throw new Error('no fork');
		expect(fork.info.subject).toMatchObject({ branchNo: 1, checkCode: 'refusal_safety', fromModel: 'model_a', toModel: 'model_b', costUsd: 0.0012 });
		expect(fork.info.refusal).toMatchObject({ probability: 0.93, ruleName: 'safety_redo', outcome: 'redo' });
	});

	it('the discarded branch: the refused send instead of the redo', () => {
		const items = plan(new Map([[forkKey(0, 2), 1]]));
		expect(items.map(describeItem)).toEqual([
			'hard refusal_safety',
			'call call-search',
			'result call-search',
			'fork 1',
			'call call-refused',
			'result call-refused'
		]);
	});

	it('the nudge: number/budget, the closed attempt, and the recovered diff', () => {
		const item = plan().find((i) => i.type === 'message' && i.nudge);
		if (item?.type !== 'message' || !item.nudge) throw new Error('no nudge');
		expect(item.nudge.index).toBe(1);
		expect(item.nudge.of).toBe(3);
		expect(item.nudge.attempt?.failureTypes).toEqual(['text_only']);
		expect(item.nudge.recovery?.first).toContain('meetup moved to Saturday, venue still open');
		expect(item.nudge.recovery?.sent).toContain('delve into the venue options');
	});

	it('routing/records decision cards keep their places; checks rows never become decision cards', () => {
		const decisionRows = demoDecisionRows.map((r, i) => ({ ...r, id: 100 + i, ts: 1 + i, latencyMs: 10 })) as DecisionEvaluation[];
		const items = plan(new Map(), [...decisionRows, ...rows]);
		const decisions = items.filter((i) => i.type === 'decision').map((i) => (i.type === 'decision' ? i.decisionGroup : ''));
		expect(decisions.sort()).toEqual(['dg-records-demo', 'dg-routing-demo']);
		expect(items[0]!.type).toBe('decision');
	});

	it('an ending verdict without a tool call goes after the ending it judged', () => {
		const ending: DecisionEvaluation = {
			...rows[0]!, id: 50, decisionGroup: 'dg-ending', ts: 4050, checkpoint: 'ending', toolCallId: null,
			attemptNo: 0, consequence: 'observed', verdictJson: JSON.stringify({ fired: [], results: [{ id: 'no_reply_intent__text', p: 0.1, t: 0.6, choice: 'intended_no_reply' }] })
		};
		const items = plan(new Map(), [...rows, ending]).map(describeItem);
		expect(items.slice(items.indexOf('text'), items.indexOf('text') + 3)).toEqual(['text', 'ending', 'nudge 1']);
	});

	it('an empty session plans nothing', () => {
		expect(
			buildBranchPlan({ tree: buildBranchTree([], 0, []), selection: new Map(), evaluations: [], gate: [], refusalEvents: [] })
		).toEqual([]);
	});

	it('message keys are unique across branches', () => {
		const keys = plan(new Map([[forkKey(0, 2), 1]])).map((i) => i.key);
		expect(new Set(keys).size).toBe(keys.length);
	});
});
