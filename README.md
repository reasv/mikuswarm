# MikuSwarm

**A self-hosted Matrix chat agent built for busy, many-user rooms: one persona that fields many overlapping conversations at once without tripping over itself.**

MikuSwarm puts a single, configurable bot persona into your Matrix rooms and lets it hold up its end of a fast group chat: answering several people in parallel, following rapid back-and-forth, remembering what was said days ago, and reaching for tools (web, a real browser, a shell sandbox, image generation) when a reply needs them. It is model-agnostic, runs entirely on your own infrastructure, and is built to be read, modified, and operated rather than treated as a black box.

---

## Why it exists

Most chat agents are designed for a tidy one-human-at-a-time exchange. Drop one into a lively room with a dozen people talking over each other and it falls apart: it answers the wrong message, replies twice to the same question, loses the thread when someone fires a quick correction, or serializes everything behind a single slow turn while the conversation moves on without it.

MikuSwarm is built specifically for that messy, concurrent setting. The name is the point: the **swarm** is a parallel session harness where *each trigger runs as its own independent agent session*, and those sessions are coordinated so the bot behaves like one coherent participant rather than a crowd of confused clones. That concurrency model (not the persona, not any single feature) is the core of the project.

A bit of positioning, kept honest:

- **versus OpenClaw**: a single-user-shaped runtime, one long-lived agentic loop where the *session is the conversation*. Dropped into a busy many-user room it effectively serializes, handling one thing at a time while the room races ahead. MikuSwarm is built on the opposite premise: the conversation and the agent session are separate things, and each trigger runs as its own concurrent session assembled from a shared timeline.
- **versus hosted assistants like Anthropic's @claude**: similar in spirit (a chat-native agent you can talk to in a room), but MikuSwarm is **self-hosted, model-agnostic, persona-driven, and purpose-built for shared multi-user chatrooms** rather than a hosted product. You own the data, choose the models, and shape the personality.

MikuSwarm is a **general** many-user-chatroom agent: the headline is the concurrency, context, and session architecture. It ships with a neutral, replaceable default persona, and additional more specific features (eg. danbooru image search) is available through off-by-default add-ons that may be enabled in settings.

---

## The swarm: a parallel session harness

The architecture rests on three deliberately decoupled ideas:

1. **A timeline**: a continuously growing, append-only event log per chat context (room, DM, thread). It observes the conversation the way any room participant would, regardless of whether the bot is "doing" anything.
2. **Agent sessions**: ephemeral agent instances spawned in response to triggers. Each reads the timeline, does work, sends messages, and then terminates. There is no persistent agent process holding conversational state, only the timeline and the short-lived sessions that read from and write to it.
3. **Context assembly**: a deterministic pipeline that turns the timeline into token-budgeted, structured LLM context for each session.

Because every trigger gets its own session, many can run at once. The interesting engineering is in keeping them from stepping on each other. The coordination layer includes:

- **A priority LLM request scheduler.** A self-hosted deployment usually shares one scarce upstream rate budget across *everything*: live replies, background summarization, diary writing, image generation. Left uncoordinated, a background job grabs the slot a live reply needs. The scheduler is a process-wide admission gate: requests queue by **class** (live chat outranks proactive posts, which outrank summarization, which outranks diary), with shallow bounded in-flight counts so prioritization is actually meaningful against a FIFO upstream. It also tracks per-model health with half-open probing, honours `Retry-After`, and transparently fails over across configured fallback models.
- **Session claims (no duplicate replies).** When a session is triggered it *claims* the message that triggered it, synchronously, the instant it is accepted. A second near-simultaneous trigger for the same message sees that claim and declines to spawn a twin. The claim drives a render-time "another session is handling this" marker and a live guard at send time, closing both the "two users reacted at once" and the "I cross-replied to something another session owns" failure modes.
- **Co-target coalescing.** Two people replying to the *same* message within a short window are folded into one session as interjections rather than spawning duplicate answers.
- **Follow-up folding.** A quick same-sender follow-up (the image that arrives just after `@miku look at this`, or a `@miku actually, London` correction) is folded into the session its predecessor produced, instead of being lost or answered half-blind. Depending on timing it steers into a running session, parks until it goes live, or resumes a just-completed one.
- **Resumable sessions.** Replying to a message the bot sent **continues the session that produced it**, appending your reply as a new turn on the same rollout, so a multi-step task (a browser session, a research dig) carries its state forward instead of restarting amnesiac. A single-consumption guard keeps resumes linear, and a "work gate" ensures only genuinely stateful sessions resume.

Each concurrent session sees the timeline as it stood when it started, is told about the other active sessions, shares no mutable state, and delivers messages that immediately appear on the timeline for its siblings to see.

---

## How it works

### Context assembly

Each session's prompt is **built once, at creation, and is append-only thereafter**, never rebuilt per turn. That makes the prefix byte-stable (cache-friendly), coherent (the session sees the world as it was when it started), and a clean base for persistence and resume. The build is a deterministic, token-budgeted, tiered layout:

```mermaid
flowchart TD
    SP["System prompt<br/>(persona + tool guidance,<br/>from SOUL.md /<br/>AGENTS.md / TOOLS.md<br/>+ skills)"]
    DIARY["Recent diary<br/>(first-person memory,<br/>optional)"]
    SUM["Summary layer<br/>(rolling hierarchical<br/>summaries of old history)"]
    COMPACT["Compact tier<br/>(older messages,<br/>one-line format)"]
    RICH["Rich tier<br/>(recent messages,<br/>full XML + metadata)"]
    FINAL["Final user turn<br/>(retrieved memory +<br/>runtime/tail satellite +<br/>trigger group + images)"]

    SP --> DIARY --> SUM --> COMPACT --> RICH --> FINAL

    FROZEN["frozen prefix<br/>(cached, never rebuilt)"]
    LIVE["live turn<br/>(first message of rollout)"]
    SP -.->|belongs to| FROZEN
    FINAL -.->|becomes| LIVE
```

As raw events age out of the rich and compact tiers they are **summarized, not dropped**; the volatile, cache-cheap final turn carries everything session-specific (the triggering messages, current runtime state, any auto-retrieved memory). See [ARCHITECTURE.md §9 / §9a](ARCHITECTURE.md).

### Session lifecycle

```mermaid
flowchart TD
    IN["Inbound Matrix message"] --> TRIG{"Trigger?<br/>(@mention, DM,<br/>reply-to-bot)"}
    TRIG -->|no| OBS["Append to timeline<br/>(observe only)"]
    TRIG -->|yes| CLAIM["Accept + claim message<br/>(synchronous, blocks<br/>duplicate twins)"]
    CLAIM --> REPLY{"Reply to a bot<br/>message?"}
    REPLY -->|"yes, completed session"| RESUME["Resume that session<br/>(append turn to<br/>existing rollout)"]
    REPLY -->|no| BUILD["Build frozen context<br/>(once, at creation)"]
    RESUME --> RUN
    BUILD --> RUN["LLM rollout"]
    RUN <--> TOOLS["Tool calls<br/>(web, browser, bash,<br/>memory, media, …)"]
    RUN --> SEND["send_message tool<br/>(the only delivery path)"]
    SEND --> FINAL{"final: true?"}
    FINAL -->|no| RUN
    FINAL -->|"yes / NO_REPLY"| DONE["Complete: release claim,<br/>discard internal state"]
    DONE -.->|"later reply continues it"| RESUME
```

Sessions never deliver text implicitly: every message goes through the `send_message` tool, and the model's raw output is treated as private scratchpad. A turn ends only on an explicit `final: true` send or the literal `NO_REPLY` (intentional silence). See [ARCHITECTURE.md §8](ARCHITECTURE.md).

### Memory

The bot is not write-only or goldfish-brained. Four cooperating subsystems give it real recall:

- **Hierarchical summarization**: aging history is condensed into multi-level summaries (summaries of summaries, unlimited depth), produced by background sessions sharing the persona.
- **First-person diary**: a background worker journals what happened, in the bot's own voice, so recent memory reads naturally back into context.
- **Hybrid retrieval**: semantic + keyword (BM25) search over the bot's memory files, with temporal decay; relevant memories are auto-retrieved into the final turn (cache-free) or fetched on demand via a tool.
- **Chat-history search & recap**: full-text search over the actual message history across rooms, plus a "what did I miss" recap that detects an absence gap and returns the finest available summaries for it.

See [ARCHITECTURE.md §9b–§9e](ARCHITECTURE.md).

### Enrichment & captioning

Persisted events are enriched out of band: attachments and linked media are downloaded, replies resolved, link previews fetched, X.com posts expanded. A separate caption worker pool describes images, video, and audio with a multimodal model (animated images are converted to short video clips first). Context build waits only as long as it must for the readiness it needs. See [ARCHITECTURE.md §7a](ARCHITECTURE.md).

### Tools

Up to ~39 tools are available to a chat session: chat actions (`send_message`, `react`, `edit_message`, polls, pins, profile), web search/fetch, a **real stealth browser** (one persistent identity with shared cookies/logins, driven via an accessibility snapshot), a **Docker shell sandbox** for `bash`/`search_files`, file editing in a sandboxed workspace, media analysis, image generation, memory read/write, and remote **MCP** servers (the default ships keyless Exa web tools, no API key needed). Niche add-ons (`danbooru`, character cards, SauceNAO reverse-image lookup, X search) are gated off by default. See [ARCHITECTURE.md §10 / §11a / §11b](ARCHITECTURE.md).

### Cost & budget limits

Spend is bounded at three levels: a **per-session** USD ceiling (with a soft agent-facing warning before a hard cutoff), **period** limits (rolling/calendar windows over a unified usage ledger), and **per-user** limits with per-user model selection. Token usage is captured from actual provider reports, not estimates. See [ARCHITECTURE.md §8d–§8g](ARCHITECTURE.md).

### Observability console

An optional in-process HTTP + SSE console exposes the bot's internals: the durable record of every session (frozen context snapshot + full transcript), a live stream of a running session's events (including tentative tokens during inference retries), the LLM scheduler's state, and a preview of exactly what context the *next* session in any room would build. It is read-only except for a few operator actions (stop / resume / retry). See [ARCHITECTURE.md §11](ARCHITECTURE.md).

### Native Rust Matrix module

The Matrix transport is a Rust NAPI module built on `matrix-sdk`, handling end-to-end encryption, media download/decryption, custom emoji, and link previews. The TypeScript side is the sole formatter of agent-facing timestamps, so the host's real timezone never leaks. See [ARCHITECTURE.md §6](ARCHITECTURE.md).

### Putting it together

```mermaid
flowchart LR
    MATRIX["Matrix<br/>(Rust native client, E2EE)"]
    subgraph CORE["MikuSwarm process"]
        TL["Timeline<br/>(append-only log)"]
        ENR["Enrichment +<br/>captioning workers"]
        SESS["Agent sessions<br/>(the swarm)"]
        MEM["Summarization /<br/>diary / retrieval"]
    end
    DB[("SQLite<br/>single-writer")]
    CONSOLE["Observability<br/>console (HTTP + SSE)"]
    LLM["LLM providers<br/>(model-agnostic)"]

    MATRIX <--> TL
    TL --> ENR --> DB
    TL --> SESS
    SESS --> TL
    SESS <--> LLM
    MEM --> DB
    TL --> MEM
    CORE --- DB
    DB --> CONSOLE
    SESS --> CONSOLE
```

---

## Quickstart

MikuSwarm ships as Docker images on GHCR. Pick a compose file, fill in `.env`, and bring it up.

1. **Choose a compose file:**
   - `docker-compose.yml`: the **full hardened stack** (agent + console + egress firewall + browser Manager + sandbox), pulled from published images. This is the default, canonical deployment. (To build the images from source instead, use `docker-compose.dev.yml`.)
   - `docker-compose.minimal.yml`: **agent + console only**. The simplest "copy + `.env` + up", with reduced isolation (no firewall, no browser, no sandbox; the app-layer SSRF guard is re-enabled in its place, and `bash`/`search_files`/`browser` tools are unavailable).

2. **Configure the environment:**
   ```bash
   cp .env.example .env
   # then edit .env
   ```
   Required vars include your Matrix login, the LLM API base URLs + key, a console token, the host `MIKUSWARM_UID`/`MIKUSWARM_GID` (and `DOCKER_GID` for the full stack), and `MIKUSWARM_IMAGE_PREFIX` (set to **your** GitHub owner; images are pulled from `ghcr.io/<owner>/mikuswarm-agent`, `-console`, `-egress`, `-sandbox`). The config loader **fails fast** if any referenced variable is missing. See the comments in [`.env.example`](.env.example) for the exact set.

3. **Bring it up:**
   ```bash
   docker compose up -d
   # or: docker compose -f docker-compose.minimal.yml up -d
   ```
   On first run, **seeding** auto-populates an empty config directory and an empty workspace from the committed `templates/` tree (copy-missing, never-overwrite, so it can never clobber an established deployment). The bot can then boot.

4. **Open the console** at `http://127.0.0.1:5173` (or your configured origin) to watch sessions live.

5. **Personalize the persona** by editing `workspace/SOUL.md` (the bot's character), along with `AGENTS.md` / `TOOLS.md` / `TAIL.md`. The shipped persona is a neutral, replaceable default.

---

## Configuration

Configuration is **TOML**, loaded from a `config/` directory in lexicographic filename order and deep-merged, with `${ENV_VAR}` substitution and TypeBox schema validation (logs redact secrets automatically). Ship defaults in `00-defaults.toml`; put your deployment's choices in local overrides.

- **`[features]`** gates the niche add-on tool groups (`character_card`, `danbooru`), off by default; turning one on also seeds its skill files.
- **`[models.*]`** declares models, rate-limit groups, fallback chains, and per-model knobs; consumers reference models by name so virtual models and fallback apply uniformly.
- **Budgets** live in `[[limits]]`, per-session ceilings, and per-user limits.

See [ARCHITECTURE.md §4](ARCHITECTURE.md) for the full schema and merge semantics.

---

## Project layout

```
src/
  timeline/        Append-only event log, routing, trigger coordination
  agent/           Session factory/runner/manager, LLM scheduler, retry & resume
  context/         Deterministic context builder, renderer, compaction
  enrichment/      Download/link-preview/reply-resolution worker pool
  captioning/      Image/video/audio caption worker pool
  summarization/   Hierarchical rolling summaries
  diary/           First-person journal memory
  retrieval/       Hybrid (semantic + BM25) memory search
  search/          Chat-history FTS search & recap
  proactive/       Self-initiated posting (opt-in)
  budget/          Period / session / per-user cost limits
  tools/           Agent tool implementations
  sandbox/         Docker shell sandbox
  browser/         Stealth browser-use control layer
  matrix/          Matrix provider + native client wrapper
  storage/         SQLite (single-writer queue)
  observability/   Structured logging, context dumps, console API
native/            Rust NAPI module (matrix-sdk, E2EE, media, previews)
console/           SvelteKit observability console (separate process)
config/            TOML config directory (lexicographic merge)
templates/         First-run seed: config + workspace + feature skills
docker/            Sandbox + browser images & lifecycle scripts
```

**[ARCHITECTURE.md](ARCHITECTURE.md)** is the deep reference: data flow, invariants, context assembly, the enrichment pipeline, the full configuration schema, and the rationale behind every design decision.

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, the type-check/test workflow, and conventions. In short: TypeScript runs directly via `tsx` (no build step; type-check with `tsc --noEmit`), tests use the Node test runner (`npm test`), and the Rust native module builds with `cargo`.

## License

MikuSwarm is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0). See [LICENSE](LICENSE).
