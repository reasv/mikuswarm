import { query } from '$app/server';
import { apiGet } from '$lib/server/api/runtime';
import { AgentsResponse } from '$lib/schemas';

/**
 * Agents meta remote (spec CONSOLE-MULTI-AGENT §2): the config-declared agents
 * and their accounts, built once at startup. Fetched once — config is fixed for
 * the process lifetime, so no poll interval is needed.
 */
export const getAgents = query(() => apiGet('/api/agents', AgentsResponse));
