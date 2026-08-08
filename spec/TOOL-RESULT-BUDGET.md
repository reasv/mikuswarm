# Tool-Result Context Budget — per-result cap + per-turn aggregate clamp

**Status**: DRAFT — proposed, nothing implemented.
Target ARCHITECTURE.md home once implemented: §10 (a "Tool-result shaping"
subsection) plus a cross-reference from §8b (context limits) and §11c (MCP —
the adapter inherits the generic layer).

**Owner sign-offs (2026-08-08)**:
- Both layers: a context-aware per-turn aggregate clamp as the enforced
  invariant, plus a configurable per-result cap as hygiene.
- Capping tool-call *parallelism* is explicitly rejected — parallel calls are
  fine; their combined result size is what must be bounded.
- Guiding principle, verbatim: "there's no reason why we should allow tool
  calls in one turn to return more than the context the agent has left."
- Defaults ON. An unbounded tool result is treated as a defect, not a feature
  a deployment must opt out of; deployments can raise or disable the knobs.

Companion spec: `PER-MEMBER-CONTEXT-FITS.md`. That one makes over-grown
contexts *route* correctly; this one stops tool results from over-growing the
context in the first place. Either alone would have prevented the 2026-08-08
production park; they compose.

---

## 1. Problem

Tool results are appended to the live rollout with no generic size control.
A few tools bound themselves ad hoc — the sandbox `bash` has
`max_output_bytes`, the text editor pages `view` against the session ceiling —
but the MCP adapter (`src/mcp/tool-adapter.ts`) and most native tools pass
results through raw. Nothing anywhere looks at the *aggregate* of a turn.

Production incident, 2026-08-08: one assistant turn issued three parallel MCP
web-search calls whose results totalled ~480 KB of JSON ≈ ~135k tokens. The
live context jumped from ~57k to ~190k in a single turn — past every preferred
model's operative window — and the session degraded to an unavailable floor
model and parked. Two distinct harms:

1. **Context blowout** — a single turn can exceed the remaining window, with
   no opportunity for the model to react (the damage is done before the next
   request is even attempted).
2. **Pure waste** — even when the window absorbs it, a ~65k-token search
   result is virtually never worth its token cost; it is priced into every
   subsequent request of the session (cache reads mitigate, not erase).

## 2. Design overview

One generic **result-shaping layer**, applied uniformly to every tool (native
and MCP alike) at the per-session tool-assembly seam (`buildSessionTools`
wraps each `AgentTool.execute`). Two layers, checked in order per result:

- **Layer 1 — per-result cap** (§3): a flat token ceiling per individual
  result. Hygiene: keeps any single result from dominating even when plenty of
  context remains.
- **Layer 2 — per-turn aggregate clamp** (§4): the enforced invariant — the
  sum of a turn's results never exceeds the context the session has left,
  minus a reserve.

Principles:

- **Truncate, never drop.** A truncated result is still a result; the tool
  call succeeded.
- **Every truncation is visible and actionable.** The marker tells the model
  how much survived and what to do about it (refine the query, paginate,
  narrow the read). "Tell the model it has been cut off" is a hard
  requirement, not a nicety.
- **Text only.** Truncation applies to the text content of a result. Image
  blocks are exempt: they are flat-charged by the token estimator
  (`estimateLiveSliceTokens`, `PER_IMAGE_TOKEN_ESTIMATE`) and independently
  bounded by the media pipeline; slicing base64 would corrupt them. Tool
  *error* strings are exempt (small, and losing an error's tail is worse than
  its cost). Image tokens still count against the Layer 2 budget.
- **Token math reuses the §5.3 estimator** — the same
  `estimateLiveSliceTokens` machinery the running context counter uses, so
  what the clamp meters is what the counter will charge.

## 3. Layer 1 — per-result cap

Config: `[agent.tools] result_max_tokens`, default **16384**, `0` = disabled.

A result whose estimated text tokens exceed the cap is truncated to the cap at
a UTF-8-safe boundary (preferring the last newline within the final 5% of the
budget), with an appended marker:

```
[tool result truncated: showing ~N of ~M tokens (per-result cap).
Refine the call — narrower query, pagination, filters — to see more.]
```

Structured results (MCP content arrays) truncate across their text blocks in
order: blocks that fit whole are kept, the first overflowing block is sliced,
later text blocks are dropped and counted into the marker's `M`.

## 4. Layer 2 — per-turn aggregate clamp

Config: `[agent.tools] result_reserve_tokens`, default **32768**;
`result_min_tokens`, default **1024**.

Per session, a **turn accumulator** tracks tool-result tokens appended since
the last committed LLM request (reset via the existing `onRequestCommitted`
seam). When a result settles, its allowance is:

```
budget    = servingWindow − runningContext − result_reserve_tokens
allowance = max(budget − accumulator, result_min_tokens)
```

- `servingWindow` — the largest operative window any serving member offers:
  with PER-MEMBER-CONTEXT-FITS, the max member window across the session's
  selectables; until that lands, the composite `operativeContextWindow`.
  Either way the invariant reads "more than the context the agent has left"
  against the window the session can actually use.
- `runningContext` — the §5.3 running counter at the time the result settles.
- `result_reserve_tokens` — headroom the clamp must not consume: the next
  request's output (`max_tokens`) plus room for subsequent turns. A single
  knob rather than a derivation; the default covers the shipped 16384
  `max_tokens` twice.

A result larger than its allowance is truncated to it, marker:

```
[tool result truncated: showing ~N of ~M tokens — this turn's combined tool
results exceeded the remaining context budget. Issue narrower calls, or work
with what is shown.]
```

**Settlement order, not fair share.** Parallel results consume the turn budget
in the order they settle; a late result in an over-budget batch is truncated
harder than an early one. A fair-share (water-filling) split across the batch
was considered and rejected: it requires holding all results until the whole
batch settles — added latency on every multi-tool turn and coupling to the
agent-runtime's dispatch internals — to optimize a case (grossly over-budget
batches) that the markers already make recoverable. `result_min_tokens`
guarantees every result keeps a useful head regardless of order; the floor may
overshoot the budget by at most `(N−1) × result_min_tokens`, which the §8b
enforcement backstop and per-member fits absorb.

## 5. What this does NOT do

- No parallelism cap (owner-rejected; parallelism is not the problem).
- No result *dropping*, reordering, or summarization — shaping is lossy only
  at the tail, and mechanical. (LLM-compressed tool results would be a
  separate, opt-in feature with its own cost model; out of scope.)
- No per-tool overrides in v1. The two knobs are global; a tool that needs a
  different bound (the text editor's own paging, sandbox `max_output_bytes`)
  already has its own and simply also passes through the generic layer, which
  is a no-op when the specific bound is tighter.

## 6. Observability

`tool_result_truncated` (info): `{ sessionId, tool, layer: "per-result" |
"turn-budget", fromTokens, toTokens, turnAccumulated }`. Rate-limited per
session. The console rollout's tool block gains a small "truncated N→M"
annotation when the log fired for that call.

## 7. Config summary

```toml
[agent.tools]
result_max_tokens     = 16384   # Layer 1 per-result cap (0 = off)
result_reserve_tokens = 32768   # Layer 2 reserved headroom
result_min_tokens     = 1024    # Layer 2 floor per result
```

All three ship in 00-defaults with these values (defaults ON — owner
sign-off above).

## 8. Testing

- Layer 1: under-cap untouched; over-cap sliced at boundary with exact marker;
  multi-block MCP results; image blocks pass through untouched; disabled at 0.
- Layer 2: accumulator resets on commit; settlement-order consumption; floor
  respected; budget derived from serving window and reserve; interaction with
  Layer 1 (tighter of the two applies).
- Integration: a synthetic 3-parallel-large-results turn stays within
  `servingWindow − reserve` (± the floor overshoot bound) and every truncated
  result carries a marker.
