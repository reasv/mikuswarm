import { query } from '$app/server';
import { Schema } from 'effect';
import { apiGet } from '$lib/server/api/runtime';
import { SessionDecisionsResponse } from '$lib/schemas';

/**
 * Session decisions endpoint (spec SESSION-RECORDS §8). Returns all
 * `decision_evaluations` rows for the session in `ts` order. Empty array when
 * the table is absent on an older backend or no decisions were recorded.
 */
const SessionId = Schema.standardSchemaV1(Schema.NonEmptyString);

export const getSessionDecisions = query(SessionId, (id) =>
	apiGet(`/api/sessions/${encodeURIComponent(id)}/decisions`, SessionDecisionsResponse)
);
