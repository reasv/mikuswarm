# Memory retrieval: judged candidates, readable excerpts, operator filters

**Status**: PROPOSAL, draft rev 1 (2026-10-08), for owner review. Not implemented.
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
- **Snippets are the block's first 200 characters** (`makeSnippet` in `src/retrieval/search.ts`), about 50 tokens. They are not the region that matched. A block that matched on its last paragraph shows only its opening line. This is the main reason a relevant hit often reads as noise.
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

## 4a. Index-time enrichment: who a block is about, from provenance

The diary has no structural author or participant tags, but **every diary block written by the pipeline has exact provenance**. It is generated from one level-1 summary range (§9c "Trigger & unit"): one room, a time range, a known set of source events. Those events carry stable sender ids. So without changing the diary format, the indexer can attach metadata to each chunk:

- `participants`: the sender ids (humans only) of the source range, with message counts. This is mechanical and exact, needs no model, and is immune to display-name changes. The block header's room and time range already locate the range. A `summaries` row links the block to its lineage.
- `mentioned` (optional, model-assisted): which of those participants, plus anyone else the block names, the text is actually about. One decision call per block at index time, asked as one `noul` per candidate person ("the entry describes <name> or an interaction with them"). The candidates are the range's participants plus names the block contains that resolve to known users of that room. Cached per content hash like filter verdicts.
- Legacy blocks (imported, header-less) get neither and keep relying on name matching.

This turns the user lane from "BM25 on a display name" into "blocks whose source conversation included this user id", optionally narrowed to "blocks about this user". It is the closest this spec can get to the user-scoped memory the owner wants without a new memory format. It also gives `recall_memory` a reliable `user` filter (a new optional argument), so the agent can scope a manual search to a person.

## 5.0 Ranking and relevance methods considered

The decision model is one option among several. They differ in what they answer (a ranking vs a keep/drop decision), where they run, and whether they can see the conversation.

| Method | What it gives | Cost and latency | Data path | Notes |
|---|---|---|---|---|
| Hybrid score as today (vector + BM25, decay) | similarity rank | free, ms | local | Not a relevance decision; the floor does not bite (§1). |
| Fusion and retrieval tuning: reciprocal rank fusion instead of the weighted sum, MMR on, multiple queries (§4) | a better candidate set | free, ms | local | Cheap wins for recall. Does not decide relevance. |
| Better embedding model (multilingual, larger, longer context) | better semantic recall | one re-embed of the corpus; per-query embed | local or remote (remote needs ZDR) | Today's model is small, English-only and capped at 512 tokens. Worth an offline comparison. |
| Local cross-encoder re-ranker (e.g. the open bge-reranker family, run on ONNX like today's embedder) | a query–passage relevance score per candidate | ~tens to hundreds of ms on CPU for 24 short passages | local, no data leaves | Scores a query against a passage. It does not read the whole conversation or the participants, and its scores need a calibrated cutoff. Availability of a Node/ONNX runtime path must be checked. |
| Hosted re-rank APIs | as above | ~100–300 ms, per-search pricing | remote; ZDR status per provider must be verified | Same limits as the local cross-encoder. Adds a vendor. |
| Decision model (§5) | a calibrated keep/drop decision per passage, with conversation, request and participants in state | ~1–1.5 s, ~$0.0005 per session | remote, ZDR routes exist | Judges "relevant to this conversation", not "similar to the query". Same machinery as the filters (§7) and other points. |
| Listwise re-ranking by a chat LLM (rank or select from the candidate list) | ranking plus selection | seconds, cents per call | remote, needs a ZDR model | The strongest reasoning, but the slowest and most expensive per session. Better as an offline labeller (§9) than on the hot path. |
| Query rewriting / hypothetical-entry generation (an LLM writes the search query or a fake diary entry to embed) | better recall on terse follow-ups | an LLM call per session | remote, needs a ZDR model | Addresses problem 3 differently from §4's conversation-window query. |
| Index-time enrichment (§4a) | exact participant tags, optional "about" tags | free (provenance) or one decision call per new block | local or the decision chain | Fixes the user lane at the source, not per query. |

**Recommended combination.**
- **First:** §4 (wider recall with several queries and fusion) plus §4a (provenance participant tags).
- **Then:** a local cross-encoder to order candidates cheaply, followed by the decision model for the final keep/drop cut on the top ~12 with the conversation in view. The cross-encoder trims what the decision model has to read; the decision model supplies the relevance judgement and the zero-result case.
- **Before committing to any of this,** compare the options offline with the §9 harness:
  - Hybrid alone, the cross-encoder alone, the decision model alone, and the combination, scored against ZDR-labelled relevance.
  - An embedding-model swap as a separate axis.

  Pick on measured precision/recall at the budgets of §10, not on assumption.

## 5. Relevance judgement: the `memory` decision point

**When.** Every human-triggered chat-lane session build that runs auto-retrieval. Proactive sessions too, with the conversation window standing in for the request (open question 2). It starts at launch, as soon as the trigger group is known: candidate recall needs only the trigger, the window and the local index. It runs in parallel with routing, records planning and the context build.

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
- Order by `relevant` probability. Among passages within 0.1 of each other, those about a participant come first.
- Pack up to `auto.max_results` (default 4) items and `auto.max_tokens` (default 2000) tokens.
- **Zero kept means no block.**
- `about_participant` only orders; it never admits a passage on its own. The owner wants participant-tied and other relevant memories alike.

**Billing layouts** (the client picks by the serving member's `billing`):
- **Per-request members (Jev).** One call: 24 passages × 2 questions over ~10–12k tokens of state, about $0.0005 at $0.042/M.
- **Per-question members (Perplexity, D1).** Re-billing 12k tokens for each of 48 questions is wasteful. The client splits instead: one call per passage, with state `{conversation, request, participants, passage}` and that passage's two questions, at bounded concurrency. This needs a generic "split by item" mode in the decision client (a point declares its item list; the client chooses whole or split per member). §5.5 of DECISION-MODEL anticipated it.

**Fallback** (the whole chain failed, timed out or is budget-blocked) is open question 1. The candidates are always available, so a fallback never costs latency.

**Billing class.** `decision`, billed to the session payee like every runtime point.

## 6. Excerpts the agent can read

- A kept block of up to `auto.excerpt_max_tokens` (default 400) is shown **whole**. With today's chunk sizes that is most of them.
- A longer block shows a window centred on its best-matching region. That is the sentence or line range with the highest query-term overlap, or the highest vector similarity at sentence granularity when embeddings exist. The window is expanded to sentence boundaries and marked `…` where cut.
- Each item keeps its citation so the agent can open the full block: `- [memory/<file>.md:<lines> · <room> · <date>] <excerpt>`.
- **`recall_memory` gets the same fix:** match-centred snippets instead of the block head. Its default length goes from 200 characters to about 600, configurable.
- The block's note tells the agent that items were judged relevant to this conversation and can be opened in full. It drops the current phrasing that frames the block as incidental.

## 7. Operator memory filters (soft delete)

**Purpose.** The operator defines criteria for memories the agent should not see. This is a reversible, auditable alternative to editing or deleting diary entries, and it keeps working as new entries are written. Example: hide entries in which the agent describes doing something the operator no longer wants, so old examples do not reinforce it.

### 7.1 Configuration

```toml
[retrieval.filters.self_harmful_habit]       # any key
description = "The entry describes the assistant <doing the unwanted thing>."
examples = { hide = ["..."], keep = ["..."] } # optional, become criteria.true / criteria.false
threshold = 0.8                               # hide at or above
enabled = true
```

- Per-agent overrides go in `[agents.<name>.retrieval.filters]`.
- A filter is one `noul` per block: "`entry` matches: <description>." The model is the `memory` point's chain, or `[retrieval.filters].model`.

### 7.2 Evaluation: precomputed, cached, re-evaluated when a filter changes

- **A background worker** evaluates each memory chunk against every enabled filter once. It stores `memory_filter_verdicts(agent, content_hash, filter_key, filter_hash, probability, hidden, model, served_version, evaluated_at)`.
  - `filter_hash` covers the description, examples and threshold. Editing a filter re-queues the whole corpus for that filter. Disabling it simply stops consulting its verdicts.
  - One block with all filters is one call (filters are independent questions). Cost of a full pass over ~4,000 blocks on Jev is about 2M tokens, roughly $0.08.
- **New or changed blocks** are evaluated when the indexer stamps them, in the same background pool.
- **A not-yet-evaluated block reaching a surface** is evaluated inline:
  - In auto-retrieval, its filter questions ride in the same relevance call, so it costs nothing extra on per-request members. The verdict is stored.
  - Elsewhere (the recency layer, `recall_memory`), the surface waits up to a short bound for the verdict. On timeout it applies `filters.pending` (`"show"`, default, or `"hide"`).
- **Decision-chain outage.** Stored verdicts keep applying. New blocks follow `filters.pending`.

### 7.3 Enforcement: every surface that shows diary text to the agent

| Surface | Today | With filters |
|---|---|---|
| Auto-retrieval | top-K snippets | hidden blocks are never candidates |
| `recall_memory` | ranked snippets | hidden blocks are dropped from results |
| Recency diary layer (§9c read side) | the latest N files' blocks | hidden blocks dropped from the layer |
| Diary writer's continuity window | the latest N files' blocks | hidden blocks dropped (stops the reinforcement loop at the source of new entries) |
| `search_memory` (ripgrep over files) | matching lines | matching lines inside a hidden block are dropped (line ranges map to chunks) |
| Direct file reads (editor, bash) | raw file | **not filtered** (open question 3) |

### 7.4 Audit

- **Console page.** Per filter: hidden count, the hidden blocks with their probabilities and citations (the operator can read them there), and changes over time. Hidden blocks also appear in a session's retrieval card as "hidden by <filter>".
- **Logs.** `memory_filter_evaluated` (aggregate counts per pass) and `memory_filter_hidden` (per surface, counts only).
- **Write-time filtering** (refusing to write such entries) is NOT part of this spec. Display-time filtering is reversible and auditable. A counterfactual entry that was never written is neither.

## 8. Placement, latency and cost

- **Latency.** Candidate recall is local: a query embed on the local model plus FTS, tens of milliseconds. The decision call takes about 1–1.5 s through a gateway and starts at launch alongside routing. The build waits for it only when assembling the final user turn, bounded by the point's timeout (default the global `[decisions].timeout_ms`). Today the auto-retrieval block is built inside the build too, so the added wall time is the part of the decision call that outlasts routing and the build, usually little or none.
- **Cost.** About $0.0005 per session on Jev; around $0.10/day at a few hundred interactive sessions. Filters cost cents per full pass.
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

## 12. Open questions for the owner

1. **Fallback when the decision chain is unavailable.**
   - (a) Today's ranking with a higher floor (e.g. 0.6), at most 2 items, match-centred excerpts.
   - (b) No block.

   (a) keeps some memory during outages. (b) avoids the noise the judged pipeline exists to remove. Recommendation: (a).
2. **Proactive sessions.** Should they run the judged retrieval with the conversation window as the request? Recommendation: yes, since joining a conversation is where remembered context helps most.
3. **Direct file reads** (editor, bash) bypass filters. The agent opened a diary file in 0.1% of sessions over 30 days. Recommendation: accept and document. A later option is to apply filters in the editor's `view` of `memory/` paths.
4. **Budgets.** Defaults `max_results` 4, `max_tokens` 2000, `excerpt_max_tokens` 400, `candidates` 24. The always-on cost becomes "up to ~2k tokens when relevant, none when not", against today's ~250 every time.
5. **`about_participant`.** Keep it as an ordering signal only, or also reserve slots for participant memories when several are relevant? With §4a tags, this question can also be answered mechanically.
6. **Which ranking methods to evaluate** (§5.0). The proposal is the §9 offline comparison of hybrid, local cross-encoder, decision model and their combination, plus an embedding-model axis, before building the hot path. Is the local cross-encoder worth the added runtime dependency, or should the decision model alone carry relevance?
7. **§4a "about" tags.** Provenance participant tags are free. The model-assisted `mentioned` tags cost one decision call per new block and one backfill pass. Worth it?
