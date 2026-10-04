import { query } from '$app/server';
import { Schema } from 'effect';
import { apiGet } from '$lib/server/api/runtime';
import { SessionRecordResponse } from '$lib/schemas';

/**
 * Session record endpoint (spec SESSION-RECORDS §8). Returns the session's own
 * record row, or null when none exists (no tool work, still in-flight, or the
 * `session_records` table is absent on an older backend).
 */
const SessionId = Schema.standardSchemaV1(Schema.NonEmptyString);

export const getSessionRecord = query(SessionId, (id) =>
	apiGet(`/api/sessions/${encodeURIComponent(id)}/record`, SessionRecordResponse)
);
