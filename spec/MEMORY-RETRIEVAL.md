# Memory retrieval: judged candidates, readable excerpts, operator filters

**Status**: PROPOSAL, draft rev 4 (2026-10-08: owner answers, §12; keyword/pattern/time-scoped filters, §7; the cross-encoder stage, §5.0a; batched vs split judging, §5). Not implemented.
**Supersedes**: spec/DECISION-MODEL.md §5.5, first half (re-ranking and richer excerpts). Summary pre-expansion (the second half of §5.5) stays out of scope.
**Builds on**: ARCHITECTURE.md §9c (diary memory, recency layer), §9d (hybrid search, `recall_memory`, auto-retrieval), §8h (decision engine, chains, calibration), spec/DECISION-MODEL.md §3 (client, fits, billing).
**Target ARCHITECTURE.md home once implemented**: §9d (auto-retrieval, `recall_memory`), §9c (recency layer filtering), §8h (the `memory` decision point).

## 0. Scope and context

The agent's long-term memory, apart from the hierarchical summaries, is the diary. It is a set of markdown files (`memory/*.md`) written in the persona's voice, cross-channel, tracked in git with the workspace. It keeps that form for continuity with the memory it inherited: months of entries predate the current diary pipeline, and moving to another format would have meant a lossy backfill. The diary is unstructured and editable by ordinary file tools, so nothing guarantees structure or consistency. People are referred to inconsistently, usually by display names that change. The user profile system is rarely used and legacy.

**The root cause of weak memory is the memory format itself.** A better system would store discrete, structured units tagged with the users involved, so retrieval could be scoped to people. **That redesign is out of scope here.** This spec improves only what can be improved without changing the corpus: how memory is retrieved, judged, excerpted and filtered before the agent sees it.

## 1. Measurements (one production deployment, 2026-10-08)

Collected from metadata and pattern counts only; no memory or message content was read.

- **Corpus.** About 4,000 chunks (one per diary block), 336 tokens on average (max 512), ~200 files spanning about seven months. Embeddings: the local default `bge-small-en-v1.5` (384-dim, English).
- **Auto-retrieval is effectively unconditional.** In the last 7 days the `<retrieved_memory>` block was present in 99% of chat sessions. 80% of those carried the maximum of 5 items (3 topical + 2 user-lane), so the `min_score` floor almost never removes anything.
- **Snippets are too short to be comprehensible.** Each item is the first 200 characters of its block (`makeSnippet` in `src/retrieval/search.ts`), about 50 tokens, and much of that is overhead:
  - the citation repeats the date (once in the file name, once as a separate field);
  - the snippet often starts with the block's own heading residue (`## Evening Events (~7:33 PM)`).

  The owner reviewed live blocks: some items are fine, but many are not understandable on their own. They read as noise: fragments too short to tell what was being discussed, so the agent cannot judge whether to look further. Being the head of the block rather than the matching part is a secondary issue. Diary blocks are often lists of loosely related events, so even a longer excerpt of scattered facts is hard to use unless it is relevant. Relevance judging (§5) and longer, cleaner excerpts (§6) address it together.
- **The agent almost never follows up.** Over 30 days and ~6,100 chat sessions:
  - `search_memory` was used in 0.5% of sessions, `recall_memory` in 0.4%, and a diary file was opened in 0.1%.
  - 0.8% of sessions did any manual memory lookup at all.
  - For comparison, `search_messages` was used in 3.3%. `user_profile_read` was used in 0.1%.
- **The user lane has no rename history on Matrix.** Alias expansion (`buildTriggerUsers`, ARCHITECTURE.md "Retrieval alias expansion") only works for senders with a `username`, so Matrix users contribute their current display name only.

## 2. Problems in the current design

1. **The snippet is the block head, not the match.** It is too short and usually the wrong part, so even a relevant hit gives the agent too little to decide whether to look further.
2. **Fixed slots, always filled.** The hybrid score is a similarity, not a relevance judgement. Raising budgets or result counts only adds noise, which is why they were kept tiny.
3. **The query is the trigger body alone.** A terse follow-up ("what about him?", "same as last time") has nothing to match on. The conversation and the reply target are not used.
4. **No relevance decision.** Nothing decides whether a candidate actually bears on the conversation, so "none" is never the answer.
5. **No way to hide undesired memories** short of editing or deleting files. Example: entries describing behaviour the operator no longer wants. Seeing them reinforces the behaviour in a loop, and they keep being written, so one-off deletion does not solve it.

## 3. Design overview

Per interactive session build:

```
query set ─► wide candidate recall (hybrid + participant tags, fused, low floor, ~24 blocks)
          ─► drop blocks hidden by operator filters (precomputed verdicts, §7)
          ─► optional cheap re-rank (local cross-encoder, §5.0)
          ─► one decision call judging the top candidates' relevance (§5)
          ─► excerpt each kept block (whole block, or a match-centred window, §6)
          ─► pack into <retrieved_memory>: 0..N items within a token budget
```

- The block may be empty, and then it is omitted entirely.
- The same filters apply to every surface that shows diary text to the agent (§7.3).
- The decision call starts at launch, in parallel with routing, so it adds little or no latency (§8).

## 4. Candidate recall (wider, cheaper to be wrong)

The re-ranker makes recall the goal. The hybrid search's job becomes "do not miss the relevant block", not "rank it first".

- **Queries** (each a hybrid search; results unioned by chunk):
  1. The trigger text, as today.
  2. The trigger plus its reply target's text, when it is a reply.
  3. The conversation window: the text of the last `auto.query_messages` (default 6) messages, as one semantic query.
- **User lanes** (lexical, as today) for every human participant that matters:
  - the requester(s);
  - the reply target's author;
  - users mentioned in the trigger.

  Each lane uses the user's current name plus up to 4 earlier names. **New, generic:** for providers without usernames (Matrix), earlier names come from the distinct `sender_display_name` values that sender id has had in the timeline, newest first.
- **Floor and cap.** `auto.candidate_min_score` (default 0.25, below today's 0.45) and `auto.candidates` (default 24), with user-lane hits reserved up to `auto.user_lane_candidates` (default 8).
- **Exclusions**: blocks already in the recency layer (as today), and blocks hidden by a filter (§7).
- **The candidate unit is the whole chunk** (one diary block, at most 512 tokens).

## 4a. Participant tags from provenance (mechanical, no model)

The diary has no structural author or participant tags, but **every diary block written by the pipeline has exact provenance**. It is generated from one level-1 summary range (§9c "Trigger & unit"): one room, a time range, a known set of source events. Those events carry stable sender ids.

So the indexer attaches a `participants` list to each such chunk: the human sender ids of its source range, with message counts.
- **Exact.** It reads ids, not names, so it is immune to display-name changes.
- **Free.** It needs no model call; it is a join over data already stored (the block header's room and time range locate the range, the `summaries` lineage gives its events).
- **Backfill** for existing blocks is the same join, run once.
- **Legacy blocks** (imported, header-less) get no tags and keep relying on name matching.

These are *presence* tags: the user took part in the conversation the entry was written from. That is not the same as the entry being about them, but it is the right scope for "my history with this person". The user lane (§4) becomes "blocks whose source conversation included this user id", with name matching as a second signal. `recall_memory` gains an optional `user` argument that scopes a manual search the same way.

## 5.0 Ranking and relevance methods considered

The decision model is one option among several. They differ in what they answer (a ranking vs a keep/drop decision), where they run, and whether they can see the conversation.

| Method | What it gives | Cost and latency | Data path | Notes |
|---|---|---|---|---|
| Hybrid score as today (vector + BM25, decay) | similarity rank | free, ms | local | Not a relevance decision; the floor does not bite (§1). |
| Fusion and retrieval tuning: reciprocal rank fusion instead of the weighted sum, MMR on, multiple queries (§4) | a better candidate set | free, ms | local | Cheap wins for recall. Does not decide relevance. |
| Better embedding model (multilingual, larger, longer context) | better semantic recall | one re-embed of the corpus; per-query embed | local or remote (remote needs ZDR) | Today's model is small, English-only and capped at 512 tokens. Worth an offline comparison. |
| Local cross-encoder re-ranker (e.g. the open bge-reranker family, run on ONNX like today's embedder) | a query–passage relevance score per candidate | to be measured: a large multilingual model over 24 passages of ~400 tokens likely costs hundreds of ms to seconds of CPU per build, and tens of ms on a GPU; a small English model is much cheaper but weaker | local, no data leaves | Scores a query against a passage. It does not read the conversation or the participants, and needs a calibrated cutoff. |
| Hosted re-rank APIs | as above | ~100–300 ms, per-search pricing | remote; ZDR status per provider must be verified | Same limits as the local cross-encoder. Adds a vendor. |
| Decision model (§5) | a calibrated keep/drop decision per passage, with conversation, request and participants in state | ~1–1.5 s, ~$0.0005 per session | remote, ZDR routes exist | Judges "relevant to this conversation", not "similar to the query". Same machinery as the filters (§7) and other points. |
| Listwise re-ranking by a chat LLM (rank or select from the candidate list) | ranking plus selection | seconds, cents per call | remote, needs a ZDR model | The strongest reasoning, but the slowest and most expensive per session. Better as an offline labeller (§9) than on the hot path. |
| Query rewriting / hypothetical-entry generation (an LLM writes the search query or a fake diary entry to embed) | better recall on terse follow-ups | an LLM call per session | remote, needs a ZDR model | Addresses problem 3 differently from §4's conversation-window query. |
| Provenance participant tags (§4a) | exact "was in the conversation" tags | free | local | Fixes the user lane at the source, not per query. |

**Recommended combination** (rev 4: the cross-encoder is part of the design, not deferred):

```
wide recall (§4, ~60 blocks) ─► cross-encoder scores every candidate (§5.0a) ─► top ~12
   ─► decision model keep/drop with the conversation in view (§5) ─► excerpts (§6)
```

- **The cross-encoder is the ranker.** It reads each query–passage pair together, so it is far better at "does this passage answer this" than vector or BM25 similarity. Because it is cheap per pair, recall can be widened to ~60 candidates without sending 60 passages to the decision model.
- **The decision model is the judge.** It sees what the cross-encoder cannot: the conversation, the reply target and the participants. It makes the keep/drop call, including "none".
- **The fallback improves too.** When the decision chain is down, the cross-encoder's calibrated score with a cutoff selects the items in place of hybrid similarity.
- **Every stage is optional and degrades in order:** no cross-encoder → the decision model judges the hybrid top ~24; no decision model → the cross-encoder cutoff; neither → the hybrid ranking with the higher floor.
- **Compare offline first** with the §9 harness: hybrid alone, cross-encoder alone, decision model alone, and the combination, scored against ZDR-labelled relevance; plus an embedding-model swap as a separate axis. The measurements choose the cut-offs and `top_n`, not the shape.

### 5.0a The cross-encoder stage

- **Config** `[retrieval.rerank]`: `enabled`, `provider = "local" | "remote"`, `model`, `top_n` (default 12), `min_score` (the fallback cutoff, calibrated), `timeout_ms`, `max_passage_tokens`.
  - **`local`:** an ONNX cross-encoder in the agent process, the same way the local embedder runs today (fastembed / onnxruntime-node). CPU only.
  - **`remote`:** an HTTP re-rank endpoint (`POST {endpoint}/rerank` with a query and a list of texts, as served by common open inference servers), so the model can run on a GPU host. Passages are diary text derived from user messages, so a remote endpoint must be self-hosted or ZDR. Startup refuses a remote endpoint without an explicit `zdr = true` acknowledgement.
- **Query.** The request plus a short conversation tail, clipped to the model's input budget alongside the passage.
- **Cost and latency** (to be measured on the deployment's hardware):
  - a large multilingual cross-encoder over ~60 passages of ~400 tokens is likely ~1 s or more of CPU per build;
  - on a GPU, tens of milliseconds;
  - a small English model is much cheaper on CPU but weaker.

  The stage runs at launch, in parallel with routing, and its time adds to the decision model's only because the judge needs its `top_n`.
- **Unavailable or slow** (timeout, error, not configured): the stage is skipped and the next stage takes the hybrid top ~24.

## 5. Relevance judgement: the `memory` decision point

**When.** Every human-triggered chat-lane session build that runs auto-retrieval. Proactive sessions too, with the conversation window standing in for the request. It starts at launch, as soon as the trigger group is known: candidate recall needs only the trigger, the window and the local index. It runs in parallel with routing, records planning and the context build.

**State** (one object; long fields clipped; candidates packed to the member's state budget, highest hybrid score first):

```json
{ "conversation": [ { "from": "alice", "text": "..." } ],
  "request": { "from": "alice", "text": "...", "reply_to": { "from": "bob", "text": "..." } },
  "participants": [ "alice", "bob" ],
  "passages": [ { "i": 0, "date": "2026-05-14", "room": "general", "text": "<the whole block>" } ] }
```

- `conversation` is the last ~8 messages, newest last, in the recent-tier rendering. Deleted messages show as placeholders (ARCHITECTURE.md §9 "Deleted messages").
- `participants` are the display names the lanes searched.
- The persona and the system prompt are left out.

**Questions** (independent `noul`s, two per passage):

- `relevant_<i>`: "`passages[i]` contains information that would help respond to `request` in this `conversation`: facts, history or earlier events about the people, things or topics being discussed."
- `about_participant_<i>`: "`passages[i]` describes one of `participants` or an interaction with them."

Phrasing follows the documented weaknesses (§2 of DECISION-MODEL): literal, no negation, no counting.

**Verdict.**
- Keep passages with `relevant_<i> ≥ relevance_threshold`. The default is 0.7, calibrated per member like the other points.
- Order by `relevant` probability. `about_participant` (and §4a presence) only breaks near-ties (within 0.1): it never outranks a clearly more relevant passage, and reserves no slots.
- Pack up to `auto.max_results` (default 4) items and `auto.max_tokens` (default 2000) tokens.
- **Zero kept means no block.**
- `about_participant` never admits a passage on its own. Participant-tied and other relevant memories are wanted alike.

**How it is asked: two layouts.** A decision request is one `state` plus a map of independent questions. Each question is answered in isolation over the same state and refers to a field by path (`passages[3].text`).
- **Batched:** one request whose state holds all candidates in `passages[]`, with `relevant_<i>` and `about_participant_<i>` per candidate (2 × 12 = 24 questions). On a per-request-billed member (Jev) the state is billed once, about 6k tokens, roughly $0.0003.
  - The documented weakness: accuracy degrades with irrelevant material in the state. Each question sees the other 11 passages as noise.
- **Split:** one request per candidate, each with state `{conversation, request, participants, passage}` and that passage's two questions, at bounded concurrency. This costs ~12 × 2k tokens, about $0.001 on Jev, with roughly the same wall time as one call. It is the natural layout for per-question-billed members (Perplexity, D1) and avoids the noise problem.
- Both need the client's "split by item" mode: the point declares its item list, and the client chooses whole or split per member, or by a per-point `layout = "batched" | "split"` setting.
- **The default is decided by the §9 offline comparison:** batched vs split accuracy on the same labelled items. Until measured, `split` is the safer default given the documented weakness. The cross-encoder's `top_n` is what keeps the split layout's call count small.

**Fallback** (the whole chain failed, timed out or is budget-blocked; owner, 2026-10-08): today's hybrid ranking with a higher floor (`auto.fallback_min_score`, default 0.6), at most `auto.fallback_max_results` (default 2) items, with the §6 excerpts. The candidates are always available, so a fallback never costs latency.

**Proactive sessions** run the judged retrieval too (owner, 2026-10-08), with the conversation window standing in for the request.

**Billing class.** `decision`, billed to the session payee like every runtime point.

## 6. Excerpts the agent can read

Excerpts must be long enough to tell what was being discussed. The citation must not eat the budget.

- **Whole blocks by default.** A kept block of up to `auto.excerpt_max_tokens` (default 400) is shown whole. With today's chunk sizes that is most of them.
- **Longer blocks.** A longer block shows its own heading text plus a window around its best-matching region: the sentence or line range with the highest query-term overlap, or the highest vector similarity at sentence granularity when embeddings exist. The window is expanded to sentence boundaries and marked `…` where cut.
- **Compact, non-repeating citation.** One short header per item, then the text:
  - The path stays, so the agent can open the full block (`memory/<file>.md:<lines>`).
  - The date is shown separately only when the file name does not already contain it. Pipeline-written day files always do.
  - The room is shown when known.
  - The block's own markdown heading markers are stripped. Heading text that only restates the time is dropped.
  - Example: `- [memory/2026-05-22.md:90-109 · general] <text>`.
- **`recall_memory` gets the same treatment:** match-centred, cleaned excerpts with the same citation form. Its default length goes from 200 characters to about 600, configurable.
- **The block's note** tells the agent that items were judged relevant to this conversation and can be opened in full. It drops the current phrasing that frames the block as incidental.

Diary blocks are often lists of loosely related events. Whole, relevant blocks are the best this spec can do with that format; making individual memories self-contained is part of the out-of-scope memory redesign (§11).

## 7. Operator memory filters (soft delete)

**Purpose.** The operator defines criteria for memories that should not be pushed into the agent's context. This is a reversible alternative to editing or deleting diary entries, and it keeps working as new entries are written. Example: entries in which the agent describes behaviour the operator no longer wants, which would otherwise reinforce it in a loop.

It is **not an access control**. A memory that must never be reachable should be deleted. Filters keep unwanted memories out of what the harness *pushes* into context. They are also applied to the memory search tools because that is easy and consistent, but direct file reads (editor, bash) stay unfiltered by design.

### 7.1 Filter kinds and configuration

A filter hides a block when it matches. There are three kinds of match, and any filter can be limited to a time range.

```toml
[retrieval.filters.unwanted_habit]           # judged: a decision-model question
description = "The entry describes the assistant <doing the unwanted thing>."
examples = { hide = ["..."], keep = ["..."] } # optional, become criteria.true / criteria.false
threshold = 0.8                               # hide at or above

[retrieval.filters.old_nickname]             # keyword: cheap, mechanical
keywords = ["some phrase", "another"]         # case-insensitive, whole words/phrases

[retrieval.filters.old_bit]                  # pattern: cheap, mechanical
patterns = ['(?i)\bsome\s+regex\b']        # regular expressions over the block text

[retrieval.filters.that_week_incident]       # any kind, scoped to a time range
description = "The entry is about <a specific event>."
after = "2026-05-10"                          # optional; date or datetime (with zone or agent tz)
before = "2026-05-18T12:00"                   # optional; either bound alone is fine
```

- **Kinds:**
  - **Judged** (`description`): one `noul` per block, "`entry` matches: <description>", with the examples as `criteria.true` / `criteria.false`. The model is the `memory` point's chain, or `[retrieval.filters].model`.
  - **Keyword** (`keywords`): a case-insensitive whole-word or whole-phrase match against the block text. No model, no cost, deterministic.
  - **Pattern** (`patterns`): regular expressions against the block text. They are validated at startup, and an invalid pattern is a config error.
- **Combining.** A filter with both `description` and `keywords`/`patterns` uses the mechanical match as a **pre-gate**: only blocks that match it are judged, so judgement runs only where it is needed. A filter with only `keywords`/`patterns` hides on the match alone.
- **Time scope** (`after` / `before`, both optional, each a date or a datetime):
  - It is compared with the block's entry time: the `entry_ts` the indexer derives from the block header, or the file date for legacy blocks.
  - A block outside the range is never hidden by that filter and is never judged for it. A filter about a past event therefore costs nothing for, and never touches, memories written later.
  - `after` is inclusive, `before` exclusive. A bare date means the start of that day in the agent's timezone.
  - A block with no entry time is out of range for any filter that has a time bound.
- `enabled = true|false` on every filter. Per-agent overrides go in `[agents.<name>.retrieval.filters]`.

### 7.2 Evaluation: mechanical first, judged lazily, cached

There is **no corpus pass and no backfill**.

- **Time scope first.** It costs nothing, and an out-of-range block skips the filter entirely.
- **Keyword and pattern filters** run inline wherever a block is about to be shown. They are deterministic, cost microseconds per block, and need no cache.
- **Judged filters** run only where a block is about to be shown, and only when it passed the filter's time scope and its pre-gate, if any. The verdict is cached:
  - The cache is `memory_filter_verdicts(agent, content_hash, filter_key, filter_hash, probability, hidden, model, served_version, evaluated_at)`.
  - `filter_hash` covers the description, examples, threshold, pre-gate and time range. Editing a filter makes its old verdicts stale. Blocks are re-judged lazily the next time they surface; nothing is re-run in bulk.
  - Disabling a filter simply stops consulting it.
- **Where judged verdicts come from:**
  - **Auto-retrieval:** a candidate without a fresh verdict has its judged-filter questions ride in the same relevance call (§5), at nearly no extra cost on per-request members. The verdict is stored.
  - **Recency diary layer and the diary writer's continuity window:** these show a handful of recent blocks that change a few times a day. Each block is judged once when it first enters the layer, at layer build time, bounded by the point's timeout, and served from the cache afterwards.
  - **Memory search tools** (`recall_memory`, `search_memory`): results without a fresh verdict are judged in one call before the tool returns.
- **Unavailable verdict** (timeout, decision-chain outage): `filters.pending` decides (`"show"`, default, or `"hide"`) for judged filters only. Mechanical filters always apply. Cached verdicts keep applying during an outage.

### 7.3 Enforcement

| Surface | Today | With filters |
|---|---|---|
| Auto-retrieval | top-K snippets | hidden blocks are never candidates |
| Recency diary layer (§9c read side) | the latest N files' blocks | hidden blocks dropped from the layer |
| Diary writer's continuity window | the latest N files' blocks | hidden blocks dropped (stops the loop where new entries are written) |
| `recall_memory` | ranked snippets | hidden blocks dropped (easy and consistent, not required) |
| `search_memory` (ripgrep over files) | matching lines | lines inside a hidden block dropped (line ranges map to chunks) |
| Direct file reads (editor, bash) | raw file | not filtered, by design |

### 7.4 Audit

- **Console.** A filters page lists, per filter, its kind, time scope and the blocks it has hidden so far, with probabilities (judged) or the matched keyword/pattern (mechanical) and citations (the operator can read them there). Hidden blocks also appear in a session's retrieval card as "hidden by <filter>".
- **Logs.** `memory_filter_hidden` (per surface, counts only).
- **Write-time filtering** (refusing to write such entries) is NOT part of this spec. Display-time filtering is reversible and auditable. A counterfactual entry that was never written is neither.

## 8. Placement, latency and cost

- **Latency.** Candidate recall is local: a query embed on the local model plus FTS, tens of milliseconds. The decision call takes about 1–1.5 s through a gateway and starts at launch alongside routing. The build waits for it only when assembling the final user turn, bounded by the point's timeout (default the global `[decisions].timeout_ms`). Today the auto-retrieval block is built inside the build too, so the added wall time is the part of the decision call that outlasts routing and the build, usually little or none.
- **Cost.** About $0.0005 per session on Jev; around $0.10/day at a few hundred interactive sessions. Filters add a few questions to calls that happen anyway, plus a handful of small calls per day for the recency layer.
- **Prompt cache.** Unchanged: the block stays in the volatile final user turn. Filtering the recency layer changes that layer only when a verdict changes, like a diary write does today.

## 9. Observability and evaluation

- **Decision rows** (point `memory`) carry the candidates (citations and hybrid scores), the answers and the kept set. A console card in the session view shows kept, dropped and hidden passages.
- **One `memory_retrieval` log per build**: `{candidates, judged, kept, tokens, source: model|fallback, ms}`.
- **Follow-up rate.** The share of sessions that open a cited memory after the block (`recall_memory`, `search_memory`, a view of a cited path). This is the before/after metric against the 0.8% baseline.
- **Offline evaluation** before tuning thresholds:
  - Build (request, conversation, candidate) items from historical sessions.
  - Label relevance with a ZDR-eligible labeller through the existing calibration tool (scripts/calibrate-checks.ts generalised to the `memory` point).
  - Calibrate `relevance_threshold` per member.
  - The harness prints only ids, labels and aggregates.

## 10. Configuration sketch

```toml
[retrieval.auto]
judge = true                  # use the memory decision point when [decisions] is on
candidates = 24
candidate_min_score = 0.25
user_lane_candidates = 8
query_messages = 6
max_results = 4
max_tokens = 2000
excerpt_max_tokens = 400

[decisions.memory]            # usual point settings: enabled, model, timeout_ms, thresholds
enabled = true
relevance_threshold = 0.7

[retrieval.filters]
pending = "show"              # unevaluated blocks on non-judged surfaces
# model = "..."               # default: the memory point's chain
[retrieval.filters.<key>]     # description, examples, threshold, enabled
```

- **Without `[decisions]`, or with `judge = false`,** auto-retrieval keeps today's behaviour with the match-centred excerpt fix (§6), so a deployment without a decision model still benefits.
- **Filters require a decision model.** Without one, no filter applies, and startup warns if filters are configured.

## 11. Out of scope

- A new memory format: structured units, user-id tags, consistent references to people. This is the root-cause fix, to be designed separately.
- Summary pre-expansion (DECISION-MODEL §5.5, second half).
- Session records in the retrieval corpus, so that a follow-up asking "why did you say that" finds the records an earlier reply used. This is related, but records have their own selection point today.
- The user profile system.
- Changing the embedding model. A stronger remote embedder is already supported by config (`[retrieval.embedding.remote]`), but diary text derives from user messages and would need a ZDR provider. Worth evaluating separately once the judged pipeline exists, because recall then matters more than precision.

## 12. Owner decisions (2026-10-08) and remaining questions

Decided:
1. **Fallback** when the decision chain is unavailable: today's ranking with a higher floor, at most 2 items, the §6 excerpts (§5).
2. **Proactive sessions** run the judged retrieval, with the conversation window as the request (§5).
3. **Filters** are about not pushing memories into context, not access control. They also apply to the memory search tools because that is easy. Direct file reads stay unfiltered. There is no backfill: blocks are judged lazily when they are about to be shown. Keyword and pattern filters are cheap mechanical alternatives (or pre-gates) to judgement, and any filter can be scoped to a time range so it never touches later memories (§7).
4. **Budgets:** up to 4 items and ~2k tokens when relevant, none otherwise (§10).
5. **Participants** only break near-ties in the ordering (§5); no reserved slots.
6. **Participant tags** come from provenance only (§4a). There are no model-assisted "about" tags.
7. **Snippets** were noise because they were too short to understand and wasted space on repeated citation parts, more than because they were the wrong part of the block (§1, §6).

Remaining:
- **Cross-encoder placement and model.** It is now part of the design (§5.0a). Still to measure on the deployment's hardware: local CPU cost vs a remote GPU endpoint, the model choice, and `top_n`.
- **Judging layout.** Batched vs split (§5), decided by the offline comparison.
