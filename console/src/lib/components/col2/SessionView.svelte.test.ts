import { render } from 'vitest-browser-svelte';
import { page } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { Schema } from 'effect';
import { SessionDetailResponse, SessionDecisionsResponse, SessionRecordResponse } from '$lib/schemas';
import { DEMO_AUDITED_SESSION, DEMO_FEATURED_SESSION, DEMO_REFUSAL_SESSION, resolveFixture } from '$lib/server/api/demo/fixtures';
import Fixture from './session-view-fixture.svelte';

// The remote queries, answered from the demo fixtures in the shape `fresh()` reads.
function remote<T>(value: T) {
	return Object.assign(Promise.resolve(value), { refresh: async () => {}, current: value });
}
function fixture<A, I>(schema: Schema.Schema<A, I>, path: string): A {
	return Schema.decodeUnknownSync(schema)(resolveFixture(path, new URLSearchParams()));
}
vi.mock('$lib/api/sessions.remote', () => ({
	getSession: (id: string) => remote(fixture(SessionDetailResponse, `/api/sessions/${id}`))
}));
vi.mock('$lib/api/sessions-record.remote', () => ({
	getSessionRecord: (id: string) => remote(fixture(SessionRecordResponse, `/api/sessions/${id}/record`))
}));
vi.mock('$lib/api/sessions-decisions.remote', () => ({
	getSessionDecisions: (id: string) => remote(fixture(SessionDecisionsResponse, `/api/sessions/${id}/decisions`))
}));
vi.mock('$lib/api/admin.remote', () => ({ abortSession: vi.fn(), resumeSession: vi.fn() }));

// Regression: the session query's refetchInterval ran while `session` was still being
// created and read it (TDZ ReferenceError), which froze the whole conversations pane.
test('SessionView renders a completed session without throwing', async () => {
	const errors: unknown[] = [];
	const onError = (event: ErrorEvent) => errors.push(event.error ?? event.message);
	window.addEventListener('error', onError);
	try {
		render(Fixture, { sessionId: DEMO_FEATURED_SESSION });
		await expect.element(page.getByText('Session record').first()).toBeInTheDocument();
		expect(errors).toEqual([]);
	} finally {
		window.removeEventListener('error', onError);
	}
});

// Regression with refusal handling present (spec REFUSAL-HANDLING §12.1–§12.2): a
// session with a stored branch, a hard refusal, gate rows and a nudge renders the
// switcher on the latest branch, with nothing read before its initialization.
test('SessionView renders a session with branches and check cards without throwing', async () => {
	const errors: unknown[] = [];
	const onError = (event: ErrorEvent) => errors.push(event.error ?? event.message);
	window.addEventListener('error', onError);
	try {
		render(Fixture, { sessionId: DEMO_REFUSAL_SESSION });
		await expect.element(page.getByTestId('fork-position')).toHaveTextContent('2/2');
		await expect.element(page.getByTestId('hard-refusal')).toBeInTheDocument();
		await expect.element(page.getByTestId('nudge-card')).toBeInTheDocument();
		await expect.element(page.getByText('style_vocabulary pattern')).toBeInTheDocument();
		await page.getByRole('button', { name: 'previous branch' }).click();
		await expect.element(page.getByTestId('fork-position')).toHaveTextContent('1/2');
		expect(errors).toEqual([]);
	} finally {
		window.removeEventListener('error', onError);
	}
});

// An old session only the offline audit judged (spec REFUSAL-HANDLING §7.6,
// §10.2): historical nudges, no live check rows. The audit's findings render:
// the nudge cards' diagnosis (self_talk) and after-correction verdicts, the judged
// refusal on the send and the judged no_reply ending, each marked as the audit's,
// and the session's audit summary.
test('SessionView renders an audited old session: the audit findings on its cards', async () => {
	const errors: unknown[] = [];
	const onError = (event: ErrorEvent) => errors.push(event.error ?? event.message);
	window.addEventListener('error', onError);
	try {
		render(Fixture, { sessionId: DEMO_AUDITED_SESSION });
		const nudges = page.getByTestId('nudge-card');
		await expect.element(nudges.first()).toBeInTheDocument();
		expect(nudges.elements()).toHaveLength(2);
		await expect.element(nudges.first()).toHaveTextContent(/self_talk/);
		await expect.element(nudges.first()).toHaveTextContent(/different_substance/);
		await expect.element(nudges.nth(1)).toHaveTextContent(/switched_to_no_reply/);
		await expect.element(page.getByText('offline audit').first()).toBeInTheDocument();
		await expect.element(page.getByText(/refusal_safety/).first()).toBeInTheDocument();
		await expect.element(page.getByText(/no_reply_intent: abandoned_written_reply/).first()).toBeInTheDocument();
		await expect.element(page.getByTestId('audit-summary')).toHaveTextContent(/send_contract done/);
		await expect.element(page.getByTestId('audit-summary')).toHaveTextContent(/refusal done/);
		expect(errors).toEqual([]);
	} finally {
		window.removeEventListener('error', onError);
	}
});
