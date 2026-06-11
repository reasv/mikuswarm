import { query } from '$app/server';
import { apiGet } from '$lib/server/api/runtime';
import { SchedulerSnapshot, LlmRequestsResponse } from '$lib/schemas';

/**
 * Scheduler observability remotes (spec LLM-FAILURE-HANDLING §9.1/§9.2): the
 * point-in-time scheduler snapshot (group budgets + per-model health) and the
 * in-memory Layer-0 request ring. Both are polled — the snapshot is cheap and
 * the ring is bounded; SSE is an optional later refinement.
 */

/** GET /api/scheduler — group budgets, waiters, sticky escalations, model health. */
export const getSchedulerSnapshot = query(() => apiGet('/api/scheduler', SchedulerSnapshot));

/** GET /api/llm-requests — settled Layer-0 attempts, newest-first. */
export const getLlmRequests = query(() => apiGet('/api/llm-requests', LlmRequestsResponse));
