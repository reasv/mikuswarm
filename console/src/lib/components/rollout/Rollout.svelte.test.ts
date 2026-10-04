import { render } from 'vitest-browser-svelte';
import { page } from '@vitest/browser/context';
import { expect, test } from 'vitest';
import Rollout from './Rollout.svelte';
import type { DecisionEvaluation } from '$lib/schemas';

// ── Harness rendering (spec SESSION-RECORDS §4, §8) ─────────────────────────────

// Harness injection messages (harness.kind = 'injection') render with a badge
// labelled "harness injection", not as plain model tool calls.
test('renders harness injection toolCall with harness injection badge', async () => {
	const messages = [
		{
			role: 'assistant',
			harness: { kind: 'injection', decisionGroup: 'dg-abc' },
			content: [{ type: 'toolCall', id: 'tc1', name: 'read_session_record', arguments: { session_id: 'ses_abc' } }]
		},
		{
			role: 'toolResult',
			harness: { kind: 'injection' },
			toolCallId: 'tc1',
			content: 'some record text'
		}
	];
	render(Rollout, { messages, decisionEvaluations: [] });

	await expect.element(page.getByText('harness injection', { exact: true })).toBeInTheDocument();
	// The underlying tool call name must also render.
	await expect.element(page.getByText('read_session_record', { exact: false })).toBeInTheDocument();
});

// A harness record-turn user prompt (harness.kind = 'record_turn') renders as the
// "Session record" section divider, and its raw text is suppressed.
test('renders record_turn user prompt as a Session record section header', async () => {
	const messages = [
		{ role: 'user', harness: { kind: 'record_turn' }, content: 'synthesize your record now' }
	];
	render(Rollout, { messages, decisionEvaluations: [] });

	// The header must appear.
	await expect.element(page.getByText('Session record', { exact: true })).toBeInTheDocument();
	// The raw harness prompt text must NOT appear.
	await expect.element(page.getByText('synthesize your record now', { exact: true })).not.toBeInTheDocument();
});

// An inline decision card is rendered when decisionEvaluations are provided.
test('renders an inline decision card for a matching decisionGroup', async () => {
	const evaluation: DecisionEvaluation = {
		id: 1, ts: 1000, decisionGroup: 'dg-xyz', point: 'records',
		agent: null, timelineKey: null, agentSessionId: null, triggerEventId: null,
		candidateSessionId: 'ses_abc', source: 'model', reason: null,
		verdictJson: '{"inject":true}', answersJson: null, stateJson: null,
		questionsJson: null, servedModel: 'test-model', servedVersion: null,
		latencyMs: 200, inputTokens: 100, costUsd: 0.001
	};
	const messages = [
		{
			role: 'assistant',
			harness: { kind: 'injection', decisionGroup: 'dg-xyz' },
			content: [{ type: 'toolCall', id: 'tc2', name: 'read_session_record', arguments: { session_id: 'ses_abc' } }]
		}
	];
	render(Rollout, { messages, decisionEvaluations: [evaluation] });

	// The "Decision" badge must appear in the inline card.
	await expect.element(page.getByText('Decision', { exact: true })).toBeInTheDocument();
	// The point label must show.
	await expect.element(page.getByText('records', { exact: true })).toBeInTheDocument();
});

// ── Resume turn test (pre-existing) ──────────────────────────────────────────

// A resumed session (reply-to-agent-msg) appends a fresh `triggerGroup` final user
// turn AFTER the completed transcript, so it lands inside the rollout slice —
// `rolloutStartIndex` (src/observability/server/handlers.ts) skips only the leading
// head run, so only a fresh session's kickoff is a head turn. The resume turn must
// render as a trigger turn via the verbatim MessageBlock, not fall through to the
// raw-JSON fallback (the "resume turn shows as JSON in the console" bug).
test('renders an in-rollout resume triggerGroup as a trigger turn, not raw JSON', async () => {
	const messages = [
		{ role: 'assistant', content: [{ type: 'text', text: 'earlier reply' }] },
		{
			type: 'triggerGroup',
			content: '<system>runtime</system>\n\nnew user message',
			tier: 'trigger',
			tokenEstimate: 42,
			timestamp: 123
		}
	];
	render(Rollout, { messages });

	// The verbatim MessageBlock gutter renders the tier label and the message type as
	// their own elements; the raw-JSON fallback would instead bury them inside a single
	// JSON <pre> blob, so an exact-text match on each is a decisive proof of the fix.
	await expect.element(page.getByText('trigger', { exact: true })).toBeInTheDocument();
	await expect.element(page.getByText('triggerGroup', { exact: true })).toBeInTheDocument();
});
