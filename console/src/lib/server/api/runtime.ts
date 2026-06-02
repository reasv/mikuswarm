import { error } from '@sveltejs/kit';
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Schema } from 'effect';
import { AgentApiClient, AgentApiClientLive } from './client';
import type { ApiError, DecodeError, UpstreamError } from '../errors';

/**
 * One module-level runtime providing the AgentApiClient layer. Remote-function
 * bodies build an Effect program and run it through `runApi`, which maps tagged
 * Effect failures onto SvelteKit `error(status, …)` (which throws) so the client
 * gets clean HTTP semantics rather than a raw Effect failure.
 */
const runtime = ManagedRuntime.make(Layer.mergeAll(AgentApiClientLive));

type BffError = ApiError | UpstreamError | DecodeError;

/** Map a tagged BFF error to a thrown SvelteKit HttpError. Never returns. */
function throwHttp(e: BffError): never {
	switch (e._tag) {
		case 'ApiError':
			// Pass the upstream status through (e.g. 401 wrong token, 404 unknown id).
			throw error(e.status, `agent API ${e.status}: ${e.message}`);
		case 'UpstreamError':
			throw error(502, `cannot reach agent API at ${e.path}`);
		case 'DecodeError':
			throw error(502, `agent API returned an unexpected shape for ${e.path}`);
	}
}

/** Run a program that may fail with a BFF tagged error; surfaces as an HttpError. */
export async function runApi<A>(
	eff: Effect.Effect<A, BffError, AgentApiClient>
): Promise<A> {
	const exit = await runtime.runPromiseExit(eff);
	if (Exit.isSuccess(exit)) return exit.value;
	const failure = Cause.failureOption(exit.cause);
	if (Option.isSome(failure)) throwHttp(failure.value);
	// Defect (unexpected): surface as a generic 500.
	throw error(500, 'BFF internal error');
}

/** Convenience: GET a path and decode it with `schema`. */
export function apiGet<A, I>(path: string, schema: Schema.Schema<A, I>): Promise<A> {
	return runApi(Effect.flatMap(AgentApiClient, (c) => c.get(path, schema)));
}

/** Convenience: POST (empty body) to a path and decode the response with `schema`. */
export function apiPost<A, I>(path: string, schema: Schema.Schema<A, I>): Promise<A> {
	return runApi(Effect.flatMap(AgentApiClient, (c) => c.post(path, schema)));
}
