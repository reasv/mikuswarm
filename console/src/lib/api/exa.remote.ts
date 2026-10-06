import { query } from '$app/server';
import { Schema } from 'effect';
import { apiGet } from '$lib/server/api/runtime';
import { ExaHealthResponse, ExaJobsResponse } from '$lib/exa-schemas';
export const getExaHealth = query(() => apiGet('/api/exa', ExaHealthResponse));
const Arg = Schema.standardSchemaV1(Schema.Struct({ cursor: Schema.optional(Schema.String) }));
export const getExaJobs = query(Arg, (arg) => apiGet(`/api/exa/jobs?limit=25${arg.cursor ? `&cursor=${encodeURIComponent(arg.cursor)}` : ''}`, ExaJobsResponse));
