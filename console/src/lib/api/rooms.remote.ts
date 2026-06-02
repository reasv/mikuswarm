import { query } from '$app/server';
import { Schema } from 'effect';
import { apiGet } from '$lib/server/api/runtime';
import { RoomContextResponse, RoomsResponse, SessionsResponse } from '$lib/schemas';

/**
 * Room-scoped read endpoints (spec §8), exposed as type-safe remote queries.
 * Bodies run on the BFF server, proxy to the in-process agent API, and decode the
 * response through Effect Schema. The same Effect Schema validates the input via
 * its Standard Schema view (`Schema.standardSchemaV1`).
 */
const TimelineKey = Schema.standardSchemaV1(Schema.NonEmptyString);

export const getRooms = query(() => apiGet('/api/rooms', RoomsResponse));

export const getRoomContext = query(TimelineKey, (key) =>
	apiGet(`/api/rooms/${encodeURIComponent(key)}/context`, RoomContextResponse)
);

export const getRoomSessions = query(TimelineKey, (key) =>
	apiGet(`/api/rooms/${encodeURIComponent(key)}/sessions`, SessionsResponse)
);
