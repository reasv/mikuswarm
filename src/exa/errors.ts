import type { ExaScope } from "./types.js";
export type ExaErrorCode = "invalid_request" | "auth_failed" | "credit_exhausted" | "rate_limited" | "upstream_failed" | "transport_failed" | "invalid_response" | "timeout" | "aborted" | "exa_unavailable";
/** Contains only sanitized diagnostic fields, never raw upstream bodies/headers. */
export class ExaError extends Error {
  constructor(readonly code: ExaErrorCode, message: string, readonly scope: ExaScope,
    readonly status?: number, readonly retryAt?: number, readonly requestId?: string,
    readonly submissionUncertain = false, readonly reportedCostUsd?: number) { super(message); this.name = "ExaError"; }
}
