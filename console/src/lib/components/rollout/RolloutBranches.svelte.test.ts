import { render } from 'vitest-browser-svelte';
import { page } from '@vitest/browser/context';
import { expect, test } from 'vitest';
import { Schema } from 'effect';
import Rollout from './Rollout.svelte';
import { SessionDecisionsResponse, SessionDetailResponse, type DecisionEvaluation } from '$lib/schemas';
import fixture from '$lib/server/api/demo/refusal-session.json';

// Branches and check cards in the rollout (spec REFUSAL-HANDLING §12.1–§12.2),
// over the demo session the agent's real gate generated (refusal-session.json).
const detail = Schema.decodeUnknownSync(SessionDetailResponse)(fixture.detail);
const decisions = [...Schema.decodeUnknownSync(SessionDecisionsResponse)(fixture.decisions).evaluations];
const props = {
	messages: detail.transcript.slice(detail.rolloutStartIndex),
	liveStart: detail.rolloutStartIndex,
	branches: detail.branches,
	refusalEvents: detail.refusalEvents,
	contract: detail.contract,
	checks: detail.checks,
	decisionEvaluations: decisions
};

test('the latest branch by default; the switcher moves to the discarded branch and back', async () => {
	render(Rollout, props);
	const position = page.getByTestId('fork-position');
	await expect.element(position).toHaveTextContent('2/2');
	await expect.element(page.getByText('viewing redo')).toBeInTheDocument();
	// The marker states why: check + description, probability, models, cost.
	await expect.element(page.getByText(/refusal_safety: Declined on safety/)).toBeInTheDocument();
	await expect.element(page.getByText('p 93%')).toBeInTheDocument();
	await expect.element(page.getByText('model_a → model_b')).toBeInTheDocument();
	await expect.element(page.getByText('discarded $0.0012')).toBeInTheDocument();
	// The live continuation: the sent message with its gate card (a style pattern hit).
	await expect.element(page.getByText(/delve into the venue options/).first()).toBeInTheDocument();
	await expect.element(page.getByText('style_vocabulary pattern')).toBeInTheDocument();

	await page.getByRole('button', { name: 'previous branch' }).click();
	await expect.element(position).toHaveTextContent('1/2');
	await expect.element(page.getByText('viewing discarded branch #1')).toBeInTheDocument();
	await expect.element(page.getByText(/I can't help with that one/).first()).toBeInTheDocument();
	await expect.element(page.getByText('refusal_safety 93%')).toBeInTheDocument();
	await expect.element(page.getByText('safety_redo', { exact: false })).toBeInTheDocument();
	expect(page.getByText(/delve into the venue options/).elements()).toHaveLength(0);

	// The redo link on the refused send's gate card goes back to the redo.
	await page.getByRole('button', { name: 'show the redo' }).click();
	await expect.element(position).toHaveTextContent('2/2');
});

test('hard refusal marker, nudge card with failure types and the recovered diff', async () => {
	render(Rollout, props);
	await expect.element(page.getByTestId('hard-refusal')).toHaveTextContent(/stop refusal · cyber/);
	await expect.element(page.getByTestId('hard-refusal')).toHaveTextContent(/retry on fallback model/);
	const nudge = page.getByTestId('nudge-card');
	await expect.element(nudge).toHaveTextContent(/nudge 1\/3/);
	await expect.element(nudge).toHaveTextContent(/text_only/);
	await expect.element(page.getByTestId('nudge-diff')).toHaveTextContent(/first attempt → sent/);
	const container = page.getByTestId('nudge-diff').element();
	expect(container.querySelector('del')?.textContent).toContain('still open');
	expect(container.querySelector('ins')?.textContent).toContain('delve');
});

test('a deep link opens the branch and the judged call', async () => {
	const { container } = render(Rollout, { ...props, focus: { branchNo: 1, toolCallId: 'call-refused', attemptNo: null } });
	await expect.element(page.getByTestId('fork-position')).toHaveTextContent('1/2');
	expect(container.querySelector('#toolcall-call-refused')).not.toBeNull();
	// A tool call id alone finds its branch too.
	const other = render(Rollout, { ...props, focus: { branchNo: null, toolCallId: 'call-refused', attemptNo: null } });
	expect(other.container.querySelector('#toolcall-call-refused')).not.toBeNull();
});

test('a clean evaluation collapses to one line until expanded', async () => {
	const clean: DecisionEvaluation = {
		...decisions[0]!,
		id: 77,
		decisionGroup: 'dg-clean',
		toolCallId: 'c-clean',
		consequence: 'sent',
		verdictJson: JSON.stringify({ fired: [], results: [{ id: 'refusal_safety__message', p: 0.02, t: 0.8 }] })
	};
	render(Rollout, {
		messages: [
			{ role: 'assistant', content: [{ type: 'toolCall', id: 'c-clean', name: 'send_message', arguments: { message: 'hi' } }] },
			{ role: 'toolResult', toolCallId: 'c-clean', content: 'sent' }
		],
		decisionEvaluations: [clean]
	});
	const card = page.getByTestId('gate-card');
	await expect.element(card).toHaveTextContent(/clean/);
	await expect.element(card).toHaveTextContent(/1 question/);
	expect(page.getByText('p 2%').elements()).toHaveLength(0);
	await page.getByText('clean', { exact: true }).click();
	await expect.element(page.getByText('p 2%')).toBeInTheDocument();
	await expect.element(page.getByText('≥ 80%')).toBeInTheDocument();
});

test('a no_reply ending card shows the sources judged and the intent verdict', async () => {
	const ending: DecisionEvaluation = {
		...decisions[0]!,
		id: 78,
		decisionGroup: 'dg-ending',
		checkpoint: 'ending',
		toolCallId: 'c-nr',
		attemptNo: 1,
		consequence: 'observed',
		verdictJson: JSON.stringify({
			fired: [],
			results: [
				{ id: 'no_reply_intent__text', p: 0.2, t: 0.6, choice: 'intended_no_reply' },
				{ id: 'refusal_safety__analysis', p: 0.04, t: 0.8 }
			]
		})
	};
	render(Rollout, {
		messages: [
			{ role: 'assistant', content: [{ type: 'toolCall', id: 'c-nr', name: 'no_reply', arguments: { analysis: 'nothing to add' } }] },
			{ role: 'toolResult', toolCallId: 'c-nr', content: 'ok' }
		],
		decisionEvaluations: [ending]
	});
	const card = page.getByTestId('gate-card');
	await expect.element(card).toHaveTextContent(/Ending/);
	await expect.element(card).toHaveTextContent(/attempt 1/);
	await expect.element(card).toHaveTextContent(/no_reply_intent: intended_no_reply/);
	await page.getByText('Ending').click();
	await expect.element(page.getByText('sources judged: text, analysis')).toBeInTheDocument();
});

test('a revise verdict shows the tool error the agent saw', async () => {
	const revise: DecisionEvaluation = {
		...decisions[1]!,
		id: 79,
		decisionGroup: 'dg-rev',
		source: 'pattern',
		toolCallId: 'c-rev',
		consequence: 'revise',
		verdictJson: JSON.stringify({ fired: ['style_vocabulary'], source: 'message', matched: 'delve' })
	};
	render(Rollout, {
		messages: [
			{ role: 'assistant', content: [{ type: 'toolCall', id: 'c-rev', name: 'send_message', arguments: { message: 'let me delve' } }] },
			{ role: 'toolResult', toolCallId: 'c-rev', isError: true, content: [{ type: 'text', text: 'Not sent: style_vocabulary. Avoid the word delve.' }] }
		],
		decisionEvaluations: [revise]
	});
	await expect.element(page.getByText('tool error the agent saw')).toBeInTheDocument();
	await expect.element(page.getByText('Not sent: style_vocabulary. Avoid the word delve.').first()).toBeInTheDocument();
});

test('a withheld refusal turn renders as such, not as a NO_REPLY text', async () => {
	render(Rollout, {
		messages: [{ role: 'assistant', harness: { kind: 'refusal_withheld' }, content: [{ type: 'text', text: 'NO_REPLY' }] }]
	});
	await expect.element(page.getByTestId('refusal-withheld')).toHaveTextContent(/refusal withheld/);
	expect(page.getByText('NO_REPLY', { exact: true }).elements()).toHaveLength(0);
});

test('a session without branches or checks renders no switcher and no cards', async () => {
	const { container } = render(Rollout, {
		messages: [{ role: 'assistant', content: [{ type: 'text', text: 'plain reply' }] }],
		branches: [],
		refusalEvents: []
	});
	await expect.element(page.getByText('plain reply')).toBeInTheDocument();
	expect(container.querySelector('[data-testid="fork-marker"]')).toBeNull();
	expect(container.querySelector('[data-testid="gate-card"]')).toBeNull();
});
