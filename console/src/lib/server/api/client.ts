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

/** Shared request → decode pipeline for both verbs (the only difference is the method). */
function request<A, I>(method: 'GET' | 'POST', path: string, schema: Schema.Schema<A, I>) {
	return Effect.gen(function* () {
		const res = yield* Effect.tryPromise({
			try: (signal) =>
				fetch(apiBaseUrl + path, {
					method,
					headers: { accept: 'application/json', ...authHeaders() },
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
	});
}

export const AgentApiClientLive = Layer.succeed(AgentApiClient, {
	get: (path, schema) => request('GET', path, schema),
	post: (path, schema) => request('POST', path, schema)
});
