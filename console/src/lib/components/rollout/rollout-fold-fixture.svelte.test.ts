import { render } from 'vitest-browser-svelte';
import { page } from '@vitest/browser/context';
import { expect, test } from 'vitest';
import Fixture from './rollout-fold-fixture.svelte';

// Decisive reactivity check for the "live view stays empty as messages roll in"
// bug: does a `.push()` into the `$state` messages array — fed through the
// `rows = streaming ? [...] : messages` derived and into the `Rollout` child —
// actually repaint? If this fails, the live fold's appends are the bug (push not
// reactive through the derived/prop chain); if it passes, the fold renders and the
// failure is in transport (events not reaching the browser).
test('a push() into the $state messages array re-renders the rollout', async () => {
	render(Fixture);
	await expect.element(page.getByText('No rollout yet.')).toBeInTheDocument();

	await page.getByRole('button', { name: 'push' }).click();
	await expect.element(page.getByText('turn-0')).toBeInTheDocument();

	await page.getByRole('button', { name: 'push' }).click();
	await expect.element(page.getByText('turn-1')).toBeInTheDocument();
});

test('a reassignment (seed) also re-renders the rollout', async () => {
	render(Fixture);
	await page.getByRole('button', { name: 'seed' }).click();
	await expect.element(page.getByText('seeded')).toBeInTheDocument();
});
