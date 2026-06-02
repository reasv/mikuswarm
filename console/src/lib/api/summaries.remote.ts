import { query } from '$app/server';
import { Schema } from 'effect';
import { apiGet } from '$lib/server/api/runtime';
import { SummaryResponse } from '$lib/schemas';

/**
 * Summary + lineage read (spec §8, §12). Consumed by the detail column in a later
 * phase; exposed now so the BFF surface is complete.
 */
const SummaryId = Schema.standardSchemaV1(Schema.NonEmptyString);

export const getSummary = query(SummaryId, (id) =>
	apiGet(`/api/summaries/${encodeURIComponent(id)}`, SummaryResponse)
);
