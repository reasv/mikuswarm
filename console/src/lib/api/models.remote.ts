import { query } from '$app/server';
import { Schema } from 'effect';
import { apiGet } from '$lib/server/api/runtime';
import { BehaviourIncidentPage, ModelBehaviourResponse } from '$lib/schemas';

/**
 * Model behaviour page (spec REFUSAL-HANDLING §12.3, §12.4), as type-safe remote
 * queries: the BFF proxies to the in-process agent API (hourly rollups + raw
 * tables for the incident log) and decodes through Effect Schema.
 */

/**
 * The page's URL filters. `window`: today | 24h | 7d | 30d | month | all;
 * `groupBy`: model | agent | site | task; `family`: group config entries by
 * `[models.*].family`; `selected`: the clicked scorecard group (scopes the
 * breakdown and the incident log); `metric`: headline rate id for the series;
 * `type`: incident type filter (refusal | nudge | redo | revision | ending).
 */
const BehaviourArgFields = {
	window: Schema.String,
	groupBy: Schema.optional(Schema.String),
	family: Schema.optional(Schema.Boolean),
	agent: Schema.optional(Schema.String),
	site: Schema.optional(Schema.String),
	task: Schema.optional(Schema.String),
	selected: Schema.optional(Schema.String),
	metric: Schema.optional(Schema.String),
	type: Schema.optional(Schema.String)
};
const BehaviourArg = Schema.standardSchemaV1(Schema.Struct(BehaviourArgFields));
const IncidentsArg = Schema.standardSchemaV1(
	Schema.Struct({ ...BehaviourArgFields, cursor: Schema.optional(Schema.String), limit: Schema.optional(Schema.Number) })
);

type Arg = { [K in keyof typeof BehaviourArgFields]?: string | boolean } & { cursor?: string; limit?: number };

function behaviourQuery(arg: Arg): string {
	const q = new URLSearchParams();
	for (const [key, value] of Object.entries(arg)) {
		if (value === undefined || value === '' || value === false) continue;
		q.set(key, value === true ? '1' : String(value));
	}
	return q.toString();
}

/** GET /api/models/behaviour — scorecard, series, breakdown, markers, first incident page, facets. */
export const getModelBehaviour = query(BehaviourArg, (arg) =>
	apiGet(`/api/models/behaviour?${behaviourQuery(arg)}`, ModelBehaviourResponse)
);

/** GET /api/models/behaviour/incidents — a further incident-log page (same filters + cursor). */
export const getModelBehaviourIncidents = query(IncidentsArg, (arg) =>
	apiGet(`/api/models/behaviour/incidents?${behaviourQuery(arg)}`, BehaviourIncidentPage)
);
