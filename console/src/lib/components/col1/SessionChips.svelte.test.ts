import { render } from 'vitest-browser-svelte';
import { page } from '@vitest/browser/context';
import { expect, test } from 'vitest';
import SessionChips from './SessionChips.svelte';

// Session-list chips (spec REFUSAL-HANDLING §12.2): refused, redone (n), nudged
// (n), revised (n), unjudged (n); zero counts and missing data render nothing.
test('renders the non-zero chips with their counts', async () => {
	render(SessionChips, { chips: { refused: 2, redone: 1, nudged: 3, revised: 0, unjudged: 1 } });
	const chips = page.getByTestId('session-chips');
	await expect.element(chips).toHaveTextContent('refused');
	await expect.element(page.getByText('redone 1')).toBeInTheDocument();
	await expect.element(page.getByText('nudged 3')).toBeInTheDocument();
	await expect.element(page.getByText('unjudged 1')).toBeInTheDocument();
	expect(page.getByText(/revised/).elements()).toHaveLength(0);
});

test('renders nothing without chips', async () => {
	const { container } = render(SessionChips, { chips: null });
	expect(container.querySelector('[data-testid="session-chips"]')).toBeNull();
	const zero = render(SessionChips, { chips: { refused: 0, redone: 0, nudged: 0, revised: 0, unjudged: 0 } });
	expect(zero.container.querySelector('[data-testid="session-chips"]')).toBeNull();
});

test('adds the late-input redo count', async () => {
	render(SessionChips, { chips: null, redoCount: 2 });
	await expect.element(page.getByText('restarted 2')).toBeInTheDocument();
});
