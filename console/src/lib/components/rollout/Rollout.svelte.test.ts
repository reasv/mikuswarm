import { render } from 'vitest-browser-svelte';
import { page } from '@vitest/browser/context';
import { expect, test } from 'vitest';
import Rollout from './Rollout.svelte';

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
