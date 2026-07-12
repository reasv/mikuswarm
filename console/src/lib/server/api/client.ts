import { Context, Effect, Layer, Schema } from 'effect';
import { apiBaseUrl, authHeaders } from '../config';
import { ApiError, DecodeError, UpstreamError } from '../errors';

/**
 * AgentApiClient — the Effect service wrapping `fetch` to the agent's in-process
 * API. Every response is decoded through an Effect Schema (fidelity guard). This
 * is the one place the bearer token is attached; it lives only on the server.
 */
export class AgentApiClient extends Context.Tag('AgentApiClient')<
	AgentApiClient,
	{
		readonly get: <A, I>(
			path: string,
			schema: Schema.Schema<A, I>
		) => Effect.Effect<A, ApiError | UpstreamError | DecodeError>;
		/**
		 * POST with an empty body to a mutating agent route (the only one today is
		 * the session-abort Stop button, spec §13). Same auth + decode discipline as
		 * `get`; the upstream status is passed through on failure so the BFF can
		 * distinguish e.g. 404 (unknown) from 409 (not running).
		 */
		readonly post: <A, I>(
			path: string,
			schema: Schema.Schema<A, I>
		) => Effect.Effect<A, ApiError | UpstreamError | DecodeError>;
	}
>() {}

/**
 * CSRF guard marker required by the observability server on state-mutating routes
 * (see `src/observability/server/index.ts` `CONSOLE_REQUEST_HEADER`). It is a
 * constant, *not* a credential: its only job is to be a custom header, which forces
 * a CORS preflight on any cross-origin browser request and so blocks simple-request
 * CSRF against the mutating routes. Sent on every request (a constant marker is
 * cleaner than gating on the verb); the server only enforces it for mutations.
 * Keep this literal in sync with the server constant of the same name.
 */
const CONSOLE_REQUEST_HEADER = 'x-console-request';

/** Shared request → decode pipeline for both verbs (the only difference is the method). */
function request<A, I>(method: 'GET' | 'POST', path: string, schema: Schema.Schema<A, I>) {
	const startedAt = performance.now();
	return Effect.gen(function* () {
		const res = yield* Effect.tryPromise({
			try: (signal) =>
				fetch(apiBaseUrl + path, {
					method,
					headers: { accept: 'application/json', [CONSOLE_REQUEST_HEADER]: '1', ...authHeaders() },
					signal
				}),
			catch: (cause) => new UpstreamError({ path, cause })
		});
		if (!res.ok) {
			const body = yield* Effect.promise(() => res.text().catch(() => ''));
			return yield* Effect.fail(
				new ApiError({ path, status: res.status, message: body.slice(0, 500) || res.statusText })
			);
		}
		const json = yield* Effect.tryPromise({
			try: () => res.json() as Promise<unknown>,
			catch: (cause) => new DecodeError({ path, cause })
		});
		return yield* Schema.decodeUnknown(schema)(json).pipe(
			Effect.mapError((cause) => new DecodeError({ path, cause }))
		);
	}).pipe(
		Effect.ensuring(
			Effect.sync(() => {
				const durationMs = performance.now() - startedAt;
				if (durationMs < 250) return;
				console.warn(
					JSON.stringify({
						level: 'warn',
						component: 'console.bff',
						message: 'agent_api_request_slow',
						method,
						path: new URL(path, 'http://agent.invalid').pathname,
						durationMs: Math.round(durationMs * 10) / 10,
						time: new Date().toISOString()
					})
				);
			})
		)
	);
}

export const AgentApiClientLive = Layer.succeed(AgentApiClient, {
	get: (path, schema) => request('GET', path, schema),
	post: (path, schema) => request('POST', path, schema)
});
