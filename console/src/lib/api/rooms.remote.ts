import { query } from '$app/server';
import { Schema } from 'effect';
import { apiGet } from '$lib/server/api/runtime';
import {
	RoomContextResponse,
	RoomsResponse,
	SessionsResponse,
	SessionFacetsResponse
} from '$lib/schemas';

/**
 * Room-scoped read endpoints (spec §8), exposed as type-safe remote queries.
 * Bodies run on the BFF server, proxy to the in-process agent API, and decode the
 * response through Effect Schema. The same Effect Schema validates the input via
 * its Standard Schema view (`Schema.standardSchemaV1`).
 */
const TimelineKey = Schema.standardSchemaV1(Schema.NonEmptyString);

/**
 * Input for the filtered sessions list (console sessions filter, ARCHITECTURE.md §11):
 * the room `key` plus the optional, AND-combined filters — free-text trigger search
 * `q`, `statuses`, and `types`. Empty/omitted filters request the unfiltered list.
 */
const SessionsQuery = Schema.standardSchemaV1(
	Schema.Struct({
		key: Schema.NonEmptyString,
		q: Schema.optional(Schema.String),
		statuses: Schema.optional(Schema.Array(Schema.String)),
		types: Schema.optional(Schema.Array(Schema.String))
	})
);

export const getRooms = query(() => apiGet('/api/rooms', RoomsResponse));

export const getRoomContext = query(TimelineKey, (key) =>
	apiGet(`/api/rooms/${encodeURIComponent(key)}/context`, RoomContextResponse)
);

export const getRoomSessions = query(SessionsQuery, ({ key, q, statuses, types }) => {
	const params = new URLSearchParams();
	if (q && q.trim().length > 0) params.set('q', q.trim());
	for (const s of statuses ?? []) params.append('status', s);
	for (const t of types ?? []) params.append('type', t);
	const qs = params.toString();
	const suffix = qs.length > 0 ? `?${qs}` : '';
	return apiGet(`/api/rooms/${encodeURIComponent(key)}/sessions${suffix}`, SessionsResponse);
});

export const getRoomSessionFacets = query(TimelineKey, (key) =>
	apiGet(`/api/rooms/${encodeURIComponent(key)}/session-facets`, SessionFacetsResponse)
);
