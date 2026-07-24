import { Effect, Layer, Schema } from 'effect';
import { AgentApiClient } from './client';
import { ApiError, DecodeError } from '../errors';
import { resolveFixture, resolveMutation } from './demo/fixtures';

/**
 * Demo-mode implementation of `AgentApiClient` (spec CONSOLE-DEMO-MODE). Instead of
 * `fetch`-ing the agent API, it resolves a curated fixture for the requested path
 * and decodes it through the caller's Effect Schema — the SAME fidelity guard the
 * live client applies to real responses, so a fixture that drifts from the wire
 * shape surfaces as a `DecodeError` exactly as a real backend drift would.
 *
 * Selected in `runtime.ts` (in place of `AgentApiClientLive`) only when
 * `MIKUSWARM_CONSOLE_DEMO` is set; default-off, so live behaviour is untouched.
 * `MIKUSWARM_CONSOLE_API_URL` / `MIKUSWARM_CONSOLE_TOKEN` are ignored here — there
 * is no upstream to reach.
 */

/** Split a request path (which may carry a querystring) into pathname + params. */
function parse(path: string): { pathname: string; params: URLSearchParams } {
	const u = new URL(path, 'http://demo.invalid');
	return { pathname: u.pathname, params: u.searchParams };
}

function serve<A, I>(
	path: string,
	schema: Schema.Schema<A, I>,
	fixture: unknown | undefined
): Effect.Effect<A, ApiError | DecodeError> {
	if (fixture === undefined) {
		return Effect.fail(new ApiError({ path, status: 404, message: 'no demo fixture for path' }));
	}
	return Schema.decodeUnknown(schema)(fixture).pipe(
		Effect.mapError((cause) => new DecodeError({ path, cause }))
	);
}

export const AgentApiClientDemo = Layer.succeed(AgentApiClient, {
	get: (path, schema) => {
		const { pathname, params } = parse(path);
		return serve(path, schema, resolveFixture(pathname, params));
	},
	post: (path, schema) => {
		const { pathname } = parse(path);
		return serve(path, schema, resolveMutation(pathname));
	}
});
