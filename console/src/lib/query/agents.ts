import { createQuery } from '@tanstack/svelte-query';
import { getAgents } from '$lib/api/agents.remote';
import { fresh } from './client';

/**
 * TanStack wrapper for the agents meta snapshot (spec CONSOLE-MULTI-AGENT §2).
 * Config is fixed for the process lifetime, so no refetchInterval: once cached,
 * the value is authoritative until the page reloads.
 */
export function agentsQuery() {
	return createQuery(() => ({
		queryKey: ['agents'] as const,
		queryFn: () => fresh(getAgents()),
		staleTime: Infinity
	}));
}
