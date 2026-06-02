import { env } from '$env/dynamic/private';

/**
 * BFF server-side configuration. Lives under `lib/server/` so SvelteKit guarantees
 * it can never be imported into a client bundle — the agent's bearer token therefore
 * cannot leak to the browser.
 *
 * Read from `$env/dynamic/private` (runtime, not build-time inlined) so the same
 * build can run against different agents without a rebuild.
 */

/** Base URL of the agent's in-process observability API (spec §8). */
export const apiBaseUrl: string = (env.MIKUSWARM_CONSOLE_API_URL ?? 'http://127.0.0.1:8799').replace(
	/\/+$/,
	''
);

/** Optional bearer token; must match the agent's `observability.server.auth_token`. */
export const apiToken: string | undefined = env.MIKUSWARM_CONSOLE_TOKEN || undefined;

/** Authorization headers to attach to every upstream request. */
export function authHeaders(): Record<string, string> {
	return apiToken ? { authorization: `Bearer ${apiToken}` } : {};
}
