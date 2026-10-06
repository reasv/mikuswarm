import { Schema } from 'effect';
const Circuit = Schema.Struct({ state: Schema.Literal('unverified', 'healthy', 'open'), reason: Schema.NullOr(Schema.String), retryAt: Schema.Number, probing: Schema.Boolean, lastObserved: Schema.NullOr(Schema.Number) });
export const ExaHealthResponse = Schema.Struct({ enabled: Schema.Boolean, researchEnabled: Schema.Boolean,
  health: Schema.NullOr(Schema.Struct({ account: Circuit, cooldownUntil: Schema.Number, endpoints: Schema.Record({ key: Schema.String, value: Circuit }) })) });
export const ExaJobsResponse = Schema.Struct({ jobs: Schema.Array(Schema.Struct({ id: Schema.String,
  status: Schema.Literal('submitting','submission_unknown','queued','running','completed','failed','cancelled'),
  agent: Schema.NullOr(Schema.String), timelineKey: Schema.String, sessionId: Schema.String, requesterId: Schema.NullOr(Schema.String),
  query: Schema.String, effort: Schema.String, createdAt: Schema.Number, updatedAt: Schema.Number,
  stopReason: Schema.NullOr(Schema.String), cost: Schema.NullOr(Schema.Number), costProvenance: Schema.Literal('reported','estimated','unknown'),
  accounted: Schema.Boolean, lastError: Schema.NullOr(Schema.String) })), total: Schema.Number, nextCursor: Schema.NullOr(Schema.String) });
export type ExaJobs = typeof ExaJobsResponse.Type;
