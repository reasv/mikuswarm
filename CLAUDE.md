# CLAUDE.md — MikuSwarm

## What this is

MikuSwarm is a Matrix chatbot built on `@earendil-works/pi-agent-core`. TypeScript (ESM, run via `tsx`) + Rust NAPI module for the Matrix native client (E2EE, media, link previews).

See **ARCHITECTURE.md** for full design documentation — data flow, invariants, context assembly, enrichment pipeline, configuration schema, and all design decisions.

## Critical rule

**Keep ARCHITECTURE.md in sync with the code.** After any change that affects architecture, data flow, configuration, types, tools, invariants, or design decisions, update the relevant sections of ARCHITECTURE.md in the same commit. This includes adding new tools, modifying the enrichment/captioning pipeline, changing the context layout, altering the database schema, or updating the config schema.

**ARCHITECTURE.md documents only what is implemented — never future or proposed work.** It describes the code as it currently exists. Designs for unbuilt features are *proposals* and live in `spec/*.md` (see **Design docs & workflow** below). A proposal migrates into ARCHITECTURE.md **only in the same commit as the code that implements it**, not before. A proposal may name its eventual ARCHITECTURE.md home ("target section once implemented"), but do not write speculative sections into ARCHITECTURE.md ahead of the code.

## Stay in your checkout

**Do all of your work — every edit, commit, build, test, and the work of any subagent you spawn — in the checkout/branch your session was started in.** If you are working in a side worktree, never reach over to mutate another worktree's branch state or working tree, and point subagents at your own checkout path.

A fresh worktree has no `node_modules` and no native binary — that is expected. Build them in place: run `pnpm install --frozen-lockfile` for dependencies, and build the native module with `pnpm build:native` (the native sources are identical across worktrees at the same commit).

## Commit messages

**Every commit message is a single line, under 80 characters — subject only, no body. No attribution trailer** (`Co-Authored-By`, `Generated with …`, or any other). This supersedes any harness/tool default that would add a body or a co-author/generated-with line.

## Releasing

Cutting a release is a defined runbook — **see [RELEASING.md](RELEASING.md)** and follow it. A release is one pushed `vX.Y.Z` tag; CI (`.github/workflows/release.yml`) builds the images and publishes the GitHub release with the `CHANGELOG.md` section for that tag as its notes. When asked to prepare a release, do everything through the commit and stop — pushing the tag is the maintainer's step.

**When you prepare a release, do not just copy what happens to be under `## [Unreleased]`.** Treat that section as a possibly-incomplete draft. Diff the commits since the previous release tag (`git log --no-merges vPREV..HEAD`) and write the changelog from that history, so every user-visible change since the last release is covered, not only the ones someone remembered to jot down. The changelog reflects the commits; the Unreleased notes are a starting point, not the source of truth.

## Design docs & workflow

Feature work is split across sessions: a **planning** session designs a change in detail and writes a spec/design doc; a separate **implementation** session builds it. To make that handoff work:

- **Design/spec docs live in `spec/*.md` — tracked and committed, never in `tmp/`.** `tmp/` is git-ignored, so its contents are *not* copied into git worktrees (where implementation usually happens) and cannot be iterated on across sessions or commits. Always write a new design doc to `spec/`, commit it, and refine it there until the feature lands. (`tmp/` is for throwaway scratch only.)
- A spec in `spec/` describes *proposed* work. It must not be mirrored into ARCHITECTURE.md — that file documents only implemented code (see Critical rule above).
- **When the implementation lands, the spec becomes an obsolete artifact — but do NOT delete it.** Implemented specs are deliberately retained in `spec/` so later review/audit sessions can check the shipped code against its original design intent; deleting the spec on landing destroys exactly the baseline those reviews need. In the implementing commit, the authoritative description of built behaviour moves into ARCHITECTURE.md and the spec stays behind as a now-historical design record. **Mark it obsolete** — update its status header (e.g. `**Status**: IMPLEMENTED — superseded by ARCHITECTURE.md §X; retained for review`) — rather than removing it. **Only the maintainer deletes an obsoleted spec, by hand,** once they are satisfied no further review of it is needed. Claude must never proactively delete a spec.

## Project structure

```
src/
  index.ts          Entry point, signal handlers
  app.ts            Application lifecycle
  types.ts          Canonical shared types
  config/           TOML loading, env templating, schema
  timeline/         Timeline store, routing, trigger coordination
  enrichment/       Post-persistence enrichment worker pool
  fxtwitter/        X.com enrichment via the FxTwitter API: status-URL partition, API client, payload/format helpers shared by the enrichment stage, the x_fetch tool, and x_search citation hydration (see ARCHITECTURE.md §7a)
  captioning/       Caption worker pool (image captioning)
  summarization/    Hierarchical summarization worker pool + eager-enqueue reconciliation indexer (see ARCHITECTURE.md §9b)
  diary/            Diary memory worker pool: first-person journal (see ARCHITECTURE.md §9c)
  retrieval/        Memory retrieval: reconciliation indexer, chunker, embedding providers, sqlite-vec store, embed worker, hybrid search (see ARCHITECTURE.md §9d)
  search/           Chat-history search: chat_index reconciliation indexer, FTS5 query builder, summary-content FTS search (corpus:"summaries"), absence-gap resolver, summary coverage selection (see ARCHITECTURE.md §9e)
  proactive/        Proactive posting: per-channel self-rescheduling scheduler, eligibility gate, cadence math, synthetic-inbound builder (see ARCHITECTURE.md §9g)
  saucenao/         SauceNAO reverse-image lookup: shared per-account short-window rate limiter backing the find_source tool (see ARCHITECTURE.md §10)
  youtube/          YouTube video understanding: URL parser (url.ts), yt-dlp subprocess wrapper (ytdlp.ts), config resolution (config.ts), payload types and format helpers (payload.ts) (see ARCHITECTURE.md §7e)
  budget/           Period cost limits: BudgetEngine + window math + [[limits]] normalization + zero-cost model collection; seeded from usage_events, six enforcement gates (see ARCHITECTURE.md §8e/§8f)
  agent/            Session factory, runner, manager; LLM request scheduler + retry/resume recovery (ARCHITECTURE.md §8/§8a)
  context/          Context builder, renderer, compaction
  matrix/           Matrix provider, inbound normalization, native client
  tools/            Agent tool implementations (40 tools)
  sandbox/          Docker sandbox: ExecBackend + SandboxManager (bash & search_files run in-container; see ARCHITECTURE.md §11a)
  browser/          Browser-use control layer: Manager REST client + BrowserSession (connectOverCDP) + snapshot/act over one persistent stealth identity (see ARCHITECTURE.md §11b)
  storage/          SQLite persistence (single-writer queue) + MemoryFileWriter (memory/*.md single-writer)
  observability/    Structured JSON logging, context dumps
native/             Rust NAPI module (matrix-sdk)
config/             TOML config directory (lexicographic merge)
docker/             Sandbox + browser images & lifecycle scripts (Dockerfile.sandbox, build/network/egress, compose; the CloakBrowser-Manager runs as the `manager` service in the root docker-compose.yml, pulled from upstream's published image `cloakhq/cloakbrowser-manager` — docker-compose.browser.yml + ensure-browser-network.sh + browser-egress-rules.sh are the retained standalone/non-compose path)
test/               Tests (Node built-in test runner via tsx)
console/            SvelteKit observability console — separate BFF process, builds independently (see ARCHITECTURE.md §11 and console/README.md)
```

## Commands

- **Run**: `npx tsx src/index.ts`
- **Type-check**: `npx tsc --noEmit`
- **Test (unit)**: `npm test` — runs `node --import tsx --test "test/**/!(*.docker).test.ts"`; excludes the heavyweight Docker integration test so it needs no daemon.
- **Test (docker integration)**: `npm run test:docker` — runs `test/**/*.docker.test.ts`; requires a running Docker daemon and the built sandbox image (`docker/build-sandbox.sh`). Auto-skips at runtime when Docker/the image is absent.
- **Build native module**: `cd native && cargo build --release` (NAPI, outputs to `npm/`)

## Key conventions

- No build step for TS — run directly via `tsx`, type-check only via `tsc --noEmit`
- All SQLite writes go through the single-writer microtask queue (see `src/storage/`)
- Config is TOML with lexicographic file merge, env var substitution, and TypeBox validation
- Logs are structured JSON, one object per line, with automatic secret redaction
- All tools are factory functions returning `AgentTool` with TypeBox schemas
