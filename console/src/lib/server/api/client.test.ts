import { describe, it, expect, vi, afterEach } from 'vitest';
import { Cause, Effect, Exit, Option } from 'effect';
import { Schema } from 'effect';
import { AgentApiClient, AgentApiClientLive } from './client';
import { ApiError } from '../errors';

/**
 * Focused tests for the BFF → agent-API client (the only mutating route is the
 * Stop button's abort POST, spec §13). We stub the global `fetch` (the same
 * convention as sse.test.ts) and run the client Effect through its live layer,
 * asserting the two branches the UI depends on:
 *   - a 200 decodes through the wire schema to the typed value;
 *   - a non-ok response surfaces an `ApiError` carrying the *upstream* status,
 *     which the remote-function runtime maps to that HTTP status (so the console
 *     can branch 409 → "already finished" vs. other → error).
 */

/** Minimal schema standing in for any decoded wire body. */
const Body = Schema.Struct({ sessionId: Schema.String, status: Schema.String });

/** Run a client method through the live layer and return its Exit. */
function runPost(path: string) {
	return Effect.runPromiseExit(
		Effect.flatMap(AgentApiClient, (c) => c.post(path, Body)).pipe(
			Effect.provide(AgentApiClientLive)
		)
	);
}

/** Build a JSON Response with the given status. */
function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

describe('AgentApiClient.post', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('decodes a 200 response to the typed value', async () => {
		vi.stubGlobal('fetch', async () =>
			jsonResponse(200, { sessionId: 's-1', status: 'interrupted' })
		);
		const exit = await runPost('/api/sessions/s-1/abort');
		expect(Exit.isSuccess(exit)).toBe(true);
		if (Exit.isSuccess(exit)) {
			expect(exit.value.sessionId).toBe('s-1');
			expect(exit.value.status).toBe('interrupted');
		}
	});

	it('attaches the CSRF marker + accept headers on the outbound request', async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
				jsonResponse(200, { sessionId: 's-1', status: 'interrupted' })
		);
		vi.stubGlobal('fetch', fetchMock);
		await runPost('/api/sessions/s-1/abort');
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		const headers = init.headers as Record<string, string>;
		expect(headers['x-console-request']).toBe('1');
		expect(headers.accept).toBe('application/json');
		expect(init.method).toBe('POST');
	});

	it('surfaces a non-ok response as an ApiError carrying the upstream status', async () => {
		vi.stubGlobal('fetch', async () => jsonResponse(409, { error: { message: 'not running' } }));
		const exit = await runPost('/api/sessions/s-1/abort');
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			const failure = Cause.failureOption(exit.cause);
			expect(Option.isSome(failure)).toBe(true);
			if (Option.isSome(failure)) {
				const err = failure.value;
				expect(err).toBeInstanceOf(ApiError);
				expect((err as ApiError).status).toBe(409);
				// Body text is preserved as the message so the console toast stays human-readable.
				expect((err as ApiError).message).toContain('not running');
			}
		}
	});
});
