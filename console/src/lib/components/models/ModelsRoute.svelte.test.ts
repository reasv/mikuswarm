import { render } from 'vitest-browser-svelte';
import { page } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import sample from '$lib/server/api/demo/model-behaviour.json';
import type { BehaviourIncidentRow } from '$lib/schemas';
import { fakeGoto, fakePage } from './fake-app-state.svelte';
import Fixture from './models-page-fixture.svelte';

// The /models route end to end in the browser: URL state → remote query argument
// → rendered sections. The remote queries answer from the generated sample; the
// incident rows depend on the `type` argument the page sends, so a test sees the
// list narrow exactly when the page forwards the filter.

const calls: Array<Record<string, unknown>> = [];
const row = (sessionId: string, types: string[]): BehaviourIncidentRow => ({
	...(sample.incidents.rows[0] as unknown as BehaviourIncidentRow),
	sessionId,
	types,
	outcome: `outcome of ${sessionId}`
});
const ROWS = [row('s-nudge', ['nudge']), row('s-refusal', ['refusal', 'nudge']), row('s-ending', ['ending'])];

function remote<T>(value: T) {
	return Object.assign(Promise.resolve(value), { refresh: async () => {}, current: value });
}
vi.mock('$app/state', () => ({ page: fakePage }));
vi.mock('$app/navigation', () => ({ goto: fakeGoto }));
vi.mock('$lib/components/layout/TopBar.svelte', async () => ({ default: (await import('./empty-stub.svelte')).default }));
vi.mock('$lib/api/models.remote', () => ({
	getModelBehaviour: (arg: Record<string, unknown>) => {
		calls.push(arg);
		const type = arg.type as string | undefined;
		const series = arg.metric ? (sample as { demoSeries: Record<string, unknown> }).demoSeries[arg.metric as string] : undefined;
		return remote({
			...sample,
			metric: (arg.metric as string | undefined) ?? null,
			...(series ? { series } : {}),
			incidents: { rows: ROWS.filter((r) => !type || r.types.includes(type)), nextCursor: null }
		});
	},
	getModelBehaviourIncidents: () => remote({ rows: [], nextCursor: null })
}));

test('/models: the incident type filter goes into the URL and the query, and narrows the list', async () => {
	render(Fixture);
	const rows = page.getByTestId('incidents').getByRole('row');
	await expect.element(page.getByText('outcome of s-ending')).toBeInTheDocument();
	expect(rows.elements()).toHaveLength(4); // header + 3
	await page.getByTestId('incident-type-refusal').click();
	await expect.element(page.getByText('outcome of s-nudge')).not.toBeInTheDocument();
	expect(fakePage.url.searchParams.get('type')).toBe('refusal');
	expect(calls.at(-1)).toMatchObject({ type: 'refusal' });
	expect(rows.elements()).toHaveLength(2);
	await expect.element(page.getByText('outcome of s-refusal')).toBeInTheDocument();
	// Clicking the active type clears it.
	await page.getByTestId('incident-type-refusal').click();
	await expect.element(page.getByText('outcome of s-nudge')).toBeInTheDocument();
	expect(fakePage.url.searchParams.get('type')).toBeNull();
});

test('/models: sort, model names and the chart metric live in the URL', async () => {
	fakePage.url = new URL('http://console.test/models');
	render(Fixture);
	await expect.element(page.getByTestId('behaviour-overview')).toBeInTheDocument();
	await page.getByTestId('sort-group').click();
	expect(fakePage.url.searchParams.get('sort')).toBe('group');
	await expect.element(page.getByTestId('scorecard-group').first()).toHaveTextContent('cap_model');
	await page.getByTestId('sort-group').click();
	expect(fakePage.url.searchParams.get('dir')).toBeNull(); // desc is the default
	await expect.element(page.getByTestId('scorecard-group').first()).toHaveTextContent('model_b');
	await page.getByRole('button', { name: 'model id' }).click();
	expect(fakePage.url.searchParams.get('label')).toBe('id');
	await expect.element(page.getByTestId('scorecard-group').first()).toHaveTextContent('vendor/model-b');
	await page.getByTestId('chart-metric').selectOptions('mix:failure_type');
	expect(fakePage.url.searchParams.get('metric')).toBe('mix:failure_type');
	await expect.element(page.getByTestId('behaviour-chart')).toBeInTheDocument();
	expect(calls.at(-1)).toMatchObject({ metric: 'mix:failure_type' });
	expect(calls.at(-1)).not.toHaveProperty('sort');
	await expect.element(page.getByTestId('audit-progress')).toHaveTextContent(/18 to go \(now\)/);
});
