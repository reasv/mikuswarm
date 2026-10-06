---
name: deep-research
description: Conduct a substantial multi-source investigation or researched list/enrichment task; retrieve, continue or cancel earlier delegated research without duplicating purchased work.
requires_any_tools: [exa_research, exa_research_result, exa_research_list, exa_research_cancel]
tools: [exa_research, exa_research_result, exa_research_list, exa_research_cancel, exa_search, exa_search_advanced, exa_fetch, x_search, x_fetch]
---

# Delegated investigation

Load `web-research` if gathering or verifying evidence and it is not already
loaded. Use ordinary search/fetch for small lookups; structured output alone
does not justify a delegated job.

`exa_research` creates paid work and blocks while this session waits for the
answer. Choose a bounded question, desired fields, inclusion/exclusion criteria
and verifiable sources. Fixed effort controls the provider budget; start with
the configured default and use only allowed efforts. Partner data sources must
be operator-allowlisted and may add cost. Input/exclusion rows help enrichment
and deduplication. Use a bounded `output_schema` for structured lists; preserve
unknown fields rather than inventing data. Remote schema references are refused.

Research does not run Grok X search. Gather important X evidence separately with
`x_search`/`x_fetch`, then synthesize and verify locally; do not promise that the
remote research job searched X through those tools.

Inspect status, stop reason and grounding. A completed response can still be
partial when its budget was reached. Spot-check decisive claims/rows with
retrieval tools and report coverage limits. Read longer saved output through
`exa_research_result` with the returned offset. Repeated collection does not
purchase another job.

If a wait is interrupted/times out, remote work remains saved under a local job
ID. Use `exa_research_result` to wait/collect it, or `exa_research_list` when the
ID is unknown. List results reflect this agent's channel visibility, not every
session's private context. There are no completion messages or automatically
resumed conversations. Do not start another job simply to check progress.
`submission_unknown` means acceptance is uncertain: do not retry; explain the
recovery limitation and request operator investigation when appropriate.

Continue a completed job with `previous_job_id` and precise new instructions or
excluded rows. Continuation is new paid work. Cancellation requires the original
requester and explicitly calls `exa_research_cancel`; ending a local wait is not
remote cancellation. Cancellation can race completion and does not refund spend.
Result/list/cancel may remain available while new research is disabled or budgets
are exhausted, but provider/network failures can still prevent collection.
