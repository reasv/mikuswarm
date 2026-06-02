import { error } from '@sveltejs/kit';
import { command } from '$app/server';
import { Schema } from 'effect';

/**
 * Admin actions (spec §13) — Phase 5, NOT YET IMPLEMENTED. This file exists to
 * pin the pattern: each admin action is a `command` (an imperative mutation from a
 * UI event handler), validated with an Effect Standard Schema, proxying to a
 * future `POST /api/admin/...` on the agent and refreshing affected queries via
 * single-flight mutation. Deliberately a stub so the BFF surface is forward-shaped.
 */
const SessionId = Schema.standardSchemaV1(Schema.NonEmptyString);

export const abortSession = command(SessionId, async (_id) => {
	throw error(501, 'admin actions are not implemented yet (spec §13, Phase 5)');
});
