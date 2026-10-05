# Native Exa retrieval and research

**Status:** PROPOSED — implementation plan; no runtime changes authorized by this document.
**Baseline:** merged checkout `a13e914`, inspected 2026-10-05.
**Target documentation on implementation:** ARCHITECTURE.md configuration, tool discovery, web tools, auxiliary/period/session cost accounting, persistence and console sections.

## 1. Goal and boundaries

Provide optional, first-class Exa search, extraction and research, replacing the shipped anonymous Exa MCP path when enabled. Match the existing external-chat-adapter capability baseline: highlighted search, configurable output sizes, batched extraction, research with structured output, effort limits, optional partner sources, result recovery and cost reporting. Improve source grounding, cancellation, errors, discovery and integration with the harness.

This is a public, deployment-independent feature. Keys and deployment choices remain operator configuration. No account credits, model selection, real hostnames, user identities or workspace contents are hardcoded.

Research calls normally **block until completion**. Other chat sessions continue through the existing harness. This feature does not add completion-triggered sessions, delayed messages, suspend/resume infrastructure, cross-session task ownership or semantic duplicate-work detection. Persisting a job is recovery/accounting, not a promise to notify later. Existing session coordination mechanisms remain authoritative.

Exclude Exa Answer, Monitors, Websets, account management and automatic contact enrichment from the initial implementation. Native Exa is not a replacement for Grok X search, specialized source tools or interactive browsing.

## 2. Verified integration seams

- `src/decisions/points/routing.ts`: independent `task__*` probability questions, per-task thresholds, authored-order union/deduplication of skills/models/tail files, highest selected thinking level. Optional independent `skill__*` questions can select multiple skills. Description-only labels are supported. No skill supersession exists or is needed here.
- `src/agent/factory.ts`: routing preloads execute synthetic `load_skill` calls. Skill frontmatter enables tools; loading is idempotent. `DynamicToolRegistry` only grows within a session; preserve that invariant.
- `src/app.ts`: session-specific tool construction, disabled-tool filtering, background allowlists and paid-tool accounting. The merged cost sink feeds both session auxiliary spending and the unified period ledger.
- `src/tools/web.ts`: existing direct fetch and DuckDuckGo HTML search. Neither is an equivalent replacement for all Exa capabilities.
- `src/workspace/skills.ts`: skill index is read at session creation; no existing capability requirement field. Skill bodies are read at load time.
- `src/bootstrap/seed.ts`: template reconciliation must preserve operator-modified files.

Do not update ARCHITECTURE.md with this proposal before implementation.

## 3. Agent-facing catalog

All tools use explicit bounded TypeBox arguments and readable text plus structured details. Names below are final proposed names. Provider arguments are translated internally; never accept arbitrary HTTP payloads or credentials from the agent.

| Tool | Main arguments | Contract | Default loading |
|---|---|---|---|
| `exa_search` | `query`, optional `num_results` | Ordinary auto search with highlights and source metadata | Immediate |
| `exa_fetch` | `urls`, optional `mode`, `max_chars`, `max_age_hours`; alternatively `content_id`, `offset`, `max_chars` | Fetch up to 20 pages, or read another slice of stored content without refetching | Immediate |
| `exa_search_advanced` | `query`, `num_results`, `mode`, domain/date/category filters, `country`, `content_mode`, `max_age_hours`, `output_schema`, `instructions` | Constrained/deeper retrieval or bounded structured extraction | Deferred |
| `exa_research` | `query`, optional `effort`, `output_schema`, `instructions`, `data_sources`, `input_data`, `exclude_data`, `previous_job_id` | Create a durable job and wait for terminal result | Deferred |
| `exa_research_result` | `job_id`, optional `wait` (default true), `offset`, `max_chars` | Collect/wait for existing work or read its stored result; never creates a run | Deferred |
| `exa_research_list` | optional `status`, `query`, `cursor`, `limit` | List locally owned, visible jobs with enough context to choose one | Deferred |
| `exa_research_cancel` | `job_id` | Request remote cancellation; report actual resulting status | Deferred |

Immediate slots are justified because evidence verification and opening a source arise during unrelated conversation. Retain the current two-tool basic-web footprint. Advanced schemas and research management remain deferred. `load_skill`/`tool_search` continue to be available through existing rules.

Basic search: auto mode, 10 results by default, maximum 20 across both search tools initially. Default highlight budget 1,500 characters per result (an intentional context budget). Do not set domain/category/date/freshness controls unless asked for their semantics. Ordinary "latest" queries use query wording; publication windows filter dates, cache-age controls affect extracted content freshness.

Fetch: text by default, 8,000 displayed characters per page, total tool output still subject to the harness result budget. Store up to 50,000 extracted characters per page by default, with a 200,000 hard configurable ceiling; request the extraction cap from Exa, not just the display cap. Report extraction truncation separately from display truncation. A content handle can reveal only what was actually extracted; obtaining more than that requires an explicitly larger new fetch. `urls` and `content_id` are mutually exclusive. Use one content representation per request, text or highlights. Surface every requested URL's outcome, including 200 responses with per-page failures, normalized URLs and missing content.

Advanced search initially supports `auto`, `fast`, `instant`, `deep`, `deep-reasoning`, subject to config. Omit modes whose API support cannot be verified during implementation; reject them clearly instead of substituting silently. Deep-lite and future modes are outside the initial supported set. Category values and allowed filter combinations must follow the current API contract. JSON schemas are bounded by size/depth/item limits; no remote schema references. Structured results retain field-level grounding. Paid generated page summaries are not included initially.

Research uses fixed effort (`minimal`, `low`, `medium`, `high`, `xhigh`), default low and cap medium. Reject invalid/over-cap requests with legal alternatives rather than silently changing their intent. Auto/ultra effort is deliberately unsupported initially: it is unnecessary for baseline parity and needs separate variable-cost policy. Partner sources are supported through an operator allowlist, empty by default. Never infer permission from an agent naming a provider. Verify actual provider IDs and account eligibility; do not copy a stale provider-name list from another adapter.

Example concise tool descriptions:

- Search: "Search the web for sources and relevant excerpts. Use exa_fetch to inspect a source; load web-research for filters, structured extraction, deeper search or X coverage."
- Fetch: "Read public web pages, or more of previously retrieved content. Returns each URL's outcome and content handles. X posts need x_fetch; interactive pages need the browser skill."
- Advanced: "Search with explicit constraints, deeper retrieval or structured extraction. Publication dates and page freshness are different controls. Permitted modes and sizes are enforced by configuration."
- Research: "Investigate a substantial multi-source question or structured list. Creates a paid job and waits for completion. Use result/list to recover existing work; do not restart it merely to check progress."
- Result/list/cancel: describe visibility scope, blocking versus status-only access, and whether the operation spends money. Cancellation is a request, not a refund or a guarantee the job was still running.

Parameter descriptions carry exact semantics and enforced bounds. Tool output includes exact recovery calls where possible. Longer query-writing, source-selection and synthesis instructions belong in skills.

## 4. Skills and activation

Create two **complementary**, not superseding, skills. Neither is always loaded.

| Skill | Trigger-first description | Tool declarations |
|---|---|---|
| `web-research` | Find current information, verify claims, compare sources, read linked pages or extract facts from websites and X. | Three Exa retrieval tools, `x_search`, `x_fetch`, fallback `web_search`, `web_fetch` |
| `deep-research` | Investigate multi-part questions across many sources, build/enrich structured lists, or retrieve, continue or cancel earlier delegated research. | Four Exa research tools plus three Exa retrieval tools and `x_search`, `x_fetch` |

Web skill body: (1) source choice, (2) ordinary search and page inspection, (3) dates/domains/freshness, (4) structured extraction, (5) X search and tweet verification, (6) citations and uncertainty, (7) partial failure/fallback. Include practical Grok instructions, not just a pointer: search X for posts/reactions/eyewitness accounts, constrain handles/dates when relevant, inspect returned coverage/hydration, use x_fetch for known posts. News/official documents use Exa; corroborate posts rather than treating reaction volume as proof.

Deep skill body: bounded research-task/schema construction, effort/source selection, supplied/excluded rows, blocking semantics, result/grounding interpretation, continuation, recovery and cancellation. It adds delegation instructions rather than repeating web guidance. Its first instruction for organic loading is: load `web-research` when gathering or verifying evidence if it has not already been loaded. No new skill dependency system. Include the key mixed-source rule: Exa's remote researcher cannot call this harness's Grok tool; gather X evidence separately and synthesize/verify locally.

Keep `x-twitter` for X-specific requests. Revise its description and TOOLS.md to remove the blanket claim that all time-sensitive work must begin with X. Update browser instructions to name the active fetch tools, and explain that interactive/login flows still require browser. Missing optional tools must not make skill loading fail.

Add optional generic skill frontmatter `requires_any_tools` (list of patterns), evaluated against the configuration-permitted session catalog before the routing index is built. Web skill requires any Exa/native/MCP web retrieval or X tool; deep skill requires any research management/create tool. This avoids stale seeded skills advertising wholly disabled capabilities. Requirements use configured capability, not transient breaker health. Apply the same eligibility check to load_skill, editor activation and synthetic preloads; no deletion/overwriting of operator skills. This is a small generic discovery extension, not an Exa-only filename filter.

### System One task mappings

No routing-engine or model-question changes. Existing independent probability questions already express overlapping requests correctly. Supply public example config, and separately update an installation's operator-authored task mapping during implementation/deployment.

| Label | Description cue | Skills |
|---|---|---|
| `web_research` | Online lookup, source reading, current facts, verification or sourced comparison, including research requiring online evidence | web-research |
| `deep_research` | Substantial multi-source investigation or list-building/enrichment with researched fields | web-research, deep-research |
| `research_followup` | Check, retrieve, extend or cancel previously delegated research | deep-research |
| X-specific existing label | X posts, accounts, threads or public reactions on X | x-twitter |
| `news` / `current_events` | Topic/freshness classification | none required; web_research independently matches evidence gathering |

Preserve existing model preferences; examples add no model routes. A tag alone never invokes a tool. `preload_skills=false` disables independent skill questions only, not task-associated preloads. Union deduplication handles overlapping labels without supersession. Direct skill selection can still work when enabled.

### Concrete walkthroughs

1. "Is this claim true?" -> web label -> web skill + Grok tools + advanced search -> search -> fetch primary evidence -> answer with citations. If routing misses, basic tools remain immediate and point to the skill.
2. "What changed today and what are developers saying?" -> web/news/X labels -> deduplicated skills -> Exa reporting and Grok reactions -> inspect posts -> distinguish confirmed facts from reactions.
3. "Find 15 projects with license, maintainer and release date" -> deep label -> both skills -> bounded schema -> blocking research -> inspect grounding and spot-check -> answer. Structured output alone does not require delegation; smaller extraction can use advanced search.
4. "Read this URL" -> immediate fetch; unavailable page -> named specialized tool or browser skill, not automatic paid research.
5. "Continue that research, excluding these entries" -> follow-up label -> list if ID unknown -> collect completed job -> new research with previous_job_id/exclusions. Continuation is new paid work.
6. "How far did that get?" -> list + result(wait=false). The tool exposes known jobs, but cross-session ownership/deduplication is explicitly not solved here.

Always-on surface budget: two compact immediate schemas, two skill-description lines, and at most three short TOOLS.md web pointers. Measure actual tokenizer overhead versus the existing MCP pair during implementation; report the delta and trim repetition. No skill bodies in every system prompt.

## 5. Configuration and selection

Proposed defaults (schema names are part of this plan):

```toml
[exa]
enabled = false
api_key = "" # operator overlay: "${EXA_API_KEY}"
request_timeout_ms = 30000
max_in_flight = 3
requests_per_second = 3

[exa.search]
enabled = true
default_results = 10
max_results = 20
highlight_chars = 1500
allowed_modes = ["auto", "fast", "instant", "deep", "deep-reasoning"]
advanced_timeout_ms = 90000

[exa.fetch]
enabled = true
max_urls = 20
display_chars = 8000
extraction_chars = 50000
max_extraction_chars = 200000
content_ttl_hours = 24
content_store_max_bytes = 104857600

[exa.research]
enabled = false
default_effort = "low"
max_effort = "medium"
allowed_data_sources = []
max_in_flight = 2
poll_interval_ms = 3000
wait_timeout_ms = 900000

[exa.fallback]
search = "native" # native | none
fetch = "native"  # native | none
```

Research is available in the initial feature but requires explicit enablement. Root-off excludes native Exa regardless of child settings. Root-on with no key is a configuration error; child limits must be coherent. Register key with redaction. Ship a blank EXA_API_KEY entry in the appropriate env template. A key in an env file alone does not guarantee container injection; document wiring without exposing its value.

Use a typed thin HTTP client over shared guarded HTTP transport, with a fixed official API origin, bearer authorization, redirects rejected and explicit AbortSignals. This keeps pacing, status/headers, cancellation and per-attempt accounting visible; do not add an SDK with hidden retries. Unit tests inject transport. No automatic paid startup test: configuration-valid starts with unverified upstream health, first real successful call establishes health.

Selection policy: native Exa enabled replaces the shipped exa MCP server's web tools; skip connecting the shipped server when none of its tools are retained. Add explicit `mcp.servers.<name>.enabled` support if absent, so an operator can disable that default cleanly. Do not disable unrelated MCP servers by URL heuristics. A deliberately customized Exa server with additional tools needs explicit operator migration rather than silently removing them.

Remove native web names from the **shipped** disabled_tools default; use provider selection to suppress them from the immediate set. Preserve explicit operator disable lists as absolute prohibitions. Config arrays replace rather than append, so migration must remove legacy disables only when the operator intends to permit fallback.

With native Exa off, preserve the existing shipped MCP behavior; operators can explicitly disable it and use native web tools. No automatic anonymous-MCP fallback from credentialed API errors.

Background summarize/condense/diary catalogs replace the MCP fetch slot with the selected allowed fetch capability; no search or research added. Background fetch failure may use direct fetch only if permitted. All worker allowlists and per-agent tool restrictions apply before fallback selection.

## 6. Runtime availability and fallback

One app-scoped Exa service owns account-wide auth/credit state plus separate search, contents, research-create and research-collection health. Collecting/cancelling existing work is not blocked merely because local budget prohibits new spending. Provider auth/network failure may still prevent it; preserve that distinction.

- Input errors, unsupported category/filter combinations, one URL failing, schema-unfillable research: actionable tool outcome, not service outage.
- 429: shared Retry-After cooldown, bounded by policy. No claim that it means exhausted credits unless upstream identifies that reason.
- Three consecutive transport/5xx failures within 60 seconds: open affected circuit for 30 seconds, exponentially increasing to 5 minutes. One half-open caller, others fail fast. Success closes; input errors and caller cancellation do not count as failures.
- Auth/confirmed credit failure: account unavailable, no tight retry loops. Permit one demand-driven retry after five minutes; restart/key reconfiguration resets state. Operator console shows reason and last observation.
- GET collection retries may back off within the caller's wait deadline. Never hold a request slot while sleeping or across the entire research job. Separate active-job cap from HTTP concurrency.

Do not remove definitions from running sessions. Every execution checks live health and budgets. New sessions choose healthy preferred tools, promote permitted native fallback when Exa retrieval is unavailable, and include one brief availability notice. Exa definitions may remain deferred so recovery needs no frozen-catalog mutation. New sessions return to normal immediate selection after recovery. Stable configuration-shaped schemas must not change on each transient error.

Running-session failure example: `exa_unavailable`, scope search, retry time, and "Use tool_search to load web_search for a basic fallback, or load web-research for X coverage." Mention alternatives only when in this session's catalog. Background sessions without discovery can perform a direct allowed fetch fallback in the tool wrapper, explicitly labelled in the result. Never silently drop advanced filters, structured requirements or freshness guarantees to make fallback succeed.

Native fallback search needs bounded timeout, AbortSignal propagation and explicit bot-check/parse-failure reporting before being advertised as reliable recovery. Browser remains a separately loaded alternative, never silently launched. Errors distinguish service unavailability from no results; no manufactured evidence.

## 7. Blocking research and durable recovery

Normal call: persist local job intent -> submit once -> persist remote ID -> poll internally -> persist terminal output/cost -> return to the same session. The overall 15-minute default is a safety deadline, not a routine four-minute handoff. On deadline, return a recoverable timeout with job ID and exact result call; never promise a later message.

Use local IDs externally to enforce ownership. Persist origin agent, account/timeline, requesting identity, session, tool-call ID, request, remote ID, timestamps, effort/providers, state, latest status, stop reason, output/grounding and accounting state. Unique (origin session, tool-call ID) prevents replay of the same invocation creating another run. A follow-up is a new job linked to the completed predecessor.

States include submitting, submission_unknown, queued, running, completed, failed, cancelled. Distinguish completed with partial/budget-limited output using stop reason; do not represent it as fully satisfied. Remote cancellation can race completion: report what actually happened. A local abort stops waiting and preserves the remote job by default; only explicit cancel requests cancellation. Explain this in operator console and tool documentation.

Never retry a create whose acceptance is uncertain. Persist submission_unknown. If API metadata can safely identify the intent on reconciliation, use that verified mechanism; otherwise require operator investigation rather than matching arbitrary jobs by query or timestamp. No assumed idempotency header.

Startup and periodic reconciliation may collect known remote IDs and finalize their storage/accounting, but **never spawn chat sessions or send notifications**. A single collector per job fans out status to waiters. Repeated result reads return stored output; no new paid research. A job created by another application under the same key is not automatically imported.

Visibility: same owning agent plus same timeline by default. Cross-timeline reads require the existing visibility resolver to authorize the source timeline; no raw remote-ID bypass. Cancellation additionally requires originating requester or operator authorization. If caller identity is unavailable, reject cancellation rather than infer authorization from possession of ID. Follow-up creation uses the same source-read check. Lists apply filters before counting/pagination. Durable job summaries provide discovery even if a session record is absent.

Content handles share the same visibility checks. Bound content storage with TTL and byte-based eviction; handles fail with an explicit expired-content error and optional refetch URL. Retain research job metadata/results for recovery under the existing operator retention policy; add documented configurable retention if none applies. Never delete nonterminal jobs automatically.

## 8. Accounting and observability

Use provider-reported costDollars as authoritative when available. Exa service IDs (e.g. exa/search, exa/contents, exa/research) identify non-LLM spending; do not create fake chat models or treat monthly free credits as zero price. Unknown cost stays visibly unknown in invocation metadata; use a documented versioned estimate for gating/ledger when necessary, clearly marked estimated. Do not invent token usage from excerpt length.

Feed tool_invocations, usage_events, existing period rules and the merged per-session auxiliary-cost lane. Preserve origin attribution even if another session collects results. Collection does not charge its caller again. Record failed/cancelled work when charged. Research finalization and its unique accounting identity must be transactional through the storage single-writer; update the in-memory engine only for newly committed cost. Reconcile pending accounting after restart. Do not reuse the existing fire-and-forget sink unchanged where it could double-charge a reconciled job.

Initial limits retain the engine's accumulated-spend semantics: check before each new paid operation, bound result/effort/concurrency, and stop new work after exhaustion. They are **not a strict account-credit cap**: in-flight work, partner charges and other applications can overshoot. A global reservation-based budget redesign is out of scope. Do not bypass service accounting via the zero-cost-model shortcut. A per-session ceiling hit must still permit returning already acquired evidence.

Console: Exa health and cooldowns, request IDs/latencies/modes/cost provenance, per-job status/origin/stop reason, and existing paid-tool spend views. No new administrative cancellation UI required initially. Redact secrets from headers/errors; avoid full upstream payloads in routine logs. Preserve grounding in durable data even when the model-facing output is shortened.

## 9. Implementation sequence and acceptance

1. Config/types/client: gates, redaction, transport/pacing/cancellation, API response validation and error taxonomy. Verify current request shapes/provider IDs against official docs and the canonical build-with-exa skill.
2. Retrieval tools and bounded content storage: basic/advanced search, batched fetch, content pagination, evidence rendering, partial failures.
3. Accounting/health integration: service spend attribution, period/session gates, circuit breakers and session-aware fallback selection. Validate native fallback before promoting it.
4. Research storage/client/tools: durable intents, blocking wait, recovery, visibility, cancellation, exactly-once final cost accounting and restart collection.
5. Activation: both skills, X/browser/TOOLS.md updates, capability eligibility, multi-label example mappings, immediate lists and all background allowlists. Verify every walkthrough from prompt through actual tool availability.
6. Console and documentation: current implementation goes into ARCHITECTURE.md in the implementing commit, config/env examples and changelog. Mark this spec IMPLEMENTED; retain it.
7. Separately configure an installation, migrate legacy disables/MCP/task mappings, and deploy only under the applicable deployment authorization. This planning session performs none of those actions.

Required tests use mocked HTTP and deterministic clock/state:

- Absent/disabled/missing-key combinations; key redaction; no network call on invalid args.
- Basic default payload; advanced filter validation; partial contents statuses; URL normalization; output/extraction truncation; content expiry and isolation.
- Retry-After, endpoint/account breaker scopes, one half-open probe, aborted calls neutral, recovery in old/new sessions, explicitly disabled fallbacks never enabled.
- Search/fetch result fallback provenance; no silent weakening of advanced requirements.
- Blocking research completes in originating tool; unrelated sessions are unaffected; deadline/abort preserves recovery ID; no completion-triggered sessions.
- Replay same invocation; ambiguous create; restart before/after terminal persistence; concurrent waiters; cancellation/completion race; failed/partial outcomes; no double billing on repeated collection.
- Agent/timeline/requester visibility on list/result/cancel/continuation and handles.
- Multi-label web+deep+X union, independent skill questions on/off, tag-only labels, routing miss -> organic skill loading, disabled capability eligibility, background fetch allowlists.
- Both session and period costs, origin attribution after recovery, missing cost metadata, model-free paid-service gating, operator modifications preserved during seeding.

Run repository type checking and appropriate tests, then the required full suite/build checks for implementation. No paid smoke test during planning. Implementation may use a separately authorized bounded live search/fetch/research smoke test and report its actual costs. Measure prompt overhead against current basic MCP tools.

## 10. Sources and contract verification

Read Exa's requested build-with-exa skill during design; refresh its endpoint references before coding. The live API can grow beyond the skill snapshot: do not automatically expose new modes or costs just because they appear in docs.

- https://exa.ai/docs/reference/search — retrieval contract
- https://exa.ai/docs/reference/get-contents — extraction contract and per-URL status
- https://exa.ai/docs/reference/agent-api/create-a-run — research creation
- https://exa.ai/docs/agent/quickstart — research lifecycle and grounding
- https://exa.ai/pricing — verify current billing; never hardcode a free-account entitlement

Implementation verification checkpoints: provider IDs/account eligibility; cancellation/stop semantics; latest API schema limits and response variants; existing DB uniqueness support for cost finalization; actual model-facing token overhead. These are contract checks, not invitations to expand the agreed scope.
