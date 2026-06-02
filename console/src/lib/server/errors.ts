import { Data } from 'effect';

/**
 * Tagged errors for the BFF → agent-API boundary. Each remote function maps these
 * to a SvelteKit `error(status, msg)` so the browser sees clean HTTP semantics
 * rather than a raw Effect failure.
 */

/** Upstream returned a non-2xx status (carries the upstream status for passthrough). */
export class ApiError extends Data.TaggedError('ApiError')<{
	readonly path: string;
	readonly status: number;
	readonly message: string;
}> {}

/** Network/transport failure reaching the in-process agent API. */
export class UpstreamError extends Data.TaggedError('UpstreamError')<{
	readonly path: string;
	readonly cause: unknown;
}> {}

/** Response body did not match the expected wire schema (fidelity guard). */
export class DecodeError extends Data.TaggedError('DecodeError')<{
	readonly path: string;
	readonly cause: unknown;
}> {}
