<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/title-dark.svg">
    <img alt="MikuSwarm" src="docs/title-light.svg" width="560">
  </picture>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/mikurunteal.png">
    <img alt="mikurun" src="docs/mikurun.png" width="880">
  </picture>
</p>

**A self-hosted agent that lives in your Matrix rooms as one of the members: anyone can @ it, and it answers with a real browser and a shell sandbox of its own. Underneath is a harness built for group chats: the chatroom is the database, and every reply runs as its own parallel, disposable agent session.**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/harness-dark.svg">
    <img alt="A chatroom timeline runs down the center. Two @miku messages each fork off a parallel, disposable agent session that reasons and runs its own tools off to the side, then sends a single reply back into the log." src="docs/harness-light.svg" width="880">
  </picture>
</p>

MikuSwarm is built around one inversion: the conversation is not the agent's session. The chat lives in its own database, ingested verbatim and summarized continuously whether or not the agent is doing anything. Every time the bot is triggered, a fresh agent session spins up with context assembled from that log, works in parallel with any other sessions, says what it has to say through an explicit send tool, and is thrown away; its thinking, tool calls, and dead ends never enter the room's history. That is the part you cannot get by pointing an existing agent at a chatroom, and it is what makes a heavyweight, fully-tooled agent viable as one member of a busy room.

The reason to want such an agent in a room at all comes from two places. OpenClaw and similar agents showed that an agent gets dramatically more useful when it lives in your messaging apps and owns a real computer (a browser, a shell, files, a schedule, a persistent identity) instead of being a chat window that only talks. @grok on X showed what happens when an agent is *public*: anyone can summon it mid-conversation to fact-check a claim, research a question, settle an argument as a neutral third party, or edit an image someone just posted, and the whole exchange lands in front of everyone, which changes what an agent is for. MikuSwarm is the combination: the first kind of toolkit doing the second kind of job, on a harness actually shaped for the room it lives in.

Concretely: the bot sits in your rooms and reads everything, like any other member. Mention it, reply to it, or DM it, and it answers, putting real work behind the answer when it needs to: web search, a stealth browser with its own persistent logins, a Docker shell sandbox it has free rein over, file editing, image generation, media analysis, remote MCP servers. It indexes the full message history of every room (and can backfill from before it joined), so it can dig up a conversation from four months ago, tell a moderator what someone usually posts about and when they joined, or recap what you missed while you were away. Background workers keep summarizing the chat and writing its first-person diary even while nobody is talking to it, so it knows what the room did last week, including the parts it was never asked about. And it plays a persona: people ask its opinion, argue with it, and treat it as one of the regulars. As far as its own context is concerned, that is what it is.

Everything runs on your own infrastructure against whatever models you configure. The shipped persona is a neutral, replaceable default, and the niche add-ons (danbooru search, character cards, reverse-image lookup, X.com search via Grok through OpenRouter) are off by default. One thing to be clear-eyed about: this is a public agent in a shared space. Anyone in the room can prompt it, and anything it can read you should assume the room can get out of it. Don't feed it secrets you wouldn't post in the channel.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/console-session-dark.png">
    <img alt="The observability console showing one session: the room and session lists, the verbatim input context, the full rollout (thinking, replies, tool calls with args and results), and a session inspector detailing identifiers, timing, and token/cost breakdown." src="docs/console-session-light.png" width="880">
  </picture>
</p>

---

## Why a group chat needs a different harness

The obvious way to build this is to point an existing OpenClaw-alike at a group chat. It fails in instructive ways, because that family of harnesses makes two assumptions a group chat breaks.

First, they are single-owner by design. The security model pairs the agent to its owner's accounts and confines it to DMs by default, which is reasonable for something that operates the owner's computer. Running one in a room full of other people means switching every one of those protections off and hoping the sandbox holds.

Second, and deeper: they treat the conversation as the agent session. There is one continuous user/assistant rollout per channel, and chat messages arrive inside it as metadata-wrapped user turns; nothing in the harness knows what a chatroom is. The consequences compound. Every message drags its JSON wrapper through the context window for as long as it stays in history. The channel serializes, because the running session *is* the channel: the agent cannot answer two people at once. And one hard question (a hundred browser tool calls, thinking blocks, failed retries) leaves its debris sitting in the middle of the conversation until compaction finally eats it, pushing the actual chat further and further away.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/rollout-dark.svg">
    <img alt="A single continuous session per channel: chat messages arrive as JSON-wrapped user turns, one question's tool retries and fetched pages lodge in the middle of the conversation, and the next user's request queues behind it all. Callout boxes label the three failure modes: messages as wrapped turns, debris in the conversation, and a serialized channel." src="docs/rollout-light.svg" width="880">
  </picture>
</p>

A group chat needs the opposite premise: **the conversation is not the session.** A room moves on its own, most of what happens there has nothing to do with the agent, and the agent has to work as one participant among many.

So MikuSwarm is chat-first, as described at the top: the chatlog (the bot's own messages included) is the durable thing, and sessions are disposable readers and writers of it. Several consequences fall out. Summarization runs against the log continuously, so compaction is never something a reply has to wait for. Raw model output never reaches the room; only explicit `send_message` calls do, which also means models that leak thinking into their responses stay contained. Every trigger is an independent, parallel session over one shared history, which is the swarm in the name. And however much work an answer took, the messages the session chose to send are its only artifact: the room's history stays clean, and a slow research dig for one person never blocks a quick answer for another.

The trade-off: sessions are normally one rollout. Replying to a bot message resumes the session that produced it when there is real state to carry forward, but long, iterative, session-continuous work like pair-programming with the room bot is deliberately out of scope. In exchange, the usage pattern a public chat agent actually sees, where the answer is the product, maps perfectly onto one session per question.

---

## The swarm: a parallel session harness

The architecture rests on three deliberately decoupled ideas:

1. **A timeline**: a continuously growing, append-only event log per chat context (room, DM, thread). It observes the conversation the way any room participant would, regardless of whether the bot is "doing" anything.
2. **Agent sessions**: ephemeral agent instances spawned in response to triggers. Each reads the timeline, does work, sends messages, and then terminates. Conversational state lives entirely in the timeline and the short-lived sessions that read from and write to it; no persistent agent process sits in between.
3. **Context assembly**: a deterministic pipeline that turns the timeline into token-budgeted, cache-prefix stable, structured LLM context for each session.

Because every trigger gets its own session, many can run at once. The interesting engineering is in keeping them from stepping on each other. The coordination layer includes:

- **A priority LLM request scheduler.** A self-hosted deployment usually shares one scarce upstream rate budget across *everything*: live replies, background summarization, diary writing, image generation. Left uncoordinated, a background job grabs the slot a live reply needs. The scheduler is a process-wide admission gate: requests queue by **class** (live chat outranks proactive posts, which outrank summarization, which outranks diary), with shallow bounded in-flight counts so prioritization is actually meaningful against a FIFO upstream. It also tracks per-model health with half-open probing, honours `Retry-After`, and transparently fails over across configured fallback models.
- **Session claims (no duplicate replies).** When a session is triggered it *claims* the message that triggered it, synchronously, the instant it is accepted. A second near-simultaneous trigger for the same message sees that claim and declines to spawn a twin. The claim drives a render-time "another session is handling this" marker and a live guard at send time, closing both the "two users reacted at once" and the "I cross-replied to something another session owns" failure modes.
- **Co-target coalescing.** Two people replying to the *same* message within a short window are folded into one session as interjections rather than spawning duplicate answers.
- **Follow-up folding.** A quick same-sender follow-up (the image that arrives just after `@miku look at this`, or a `@miku actually, London` correction) is folded into the session its predecessor produced, instead of being lost or answered half-blind. Depending on timing it steers into a running session, parks until it goes live, or resumes a just-completed one.
- **Resumable sessions.** Replying to a message the bot sent **continues the session that produced it**, appending your reply as a new turn on the same rollout, so a multi-step task (a browser session, a research dig) carries its state forward instead of restarting amnesiac. A single-consumption guard keeps resumes linear, and a "work gate" ensures only genuinely stateful sessions resume. Basically, sessions that only contain thinking and send_message calls will never be resumed, only ones that contain meaningful tool calls and stateful work.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/swarm-dark.svg">
    <img alt="A chatroom timeline on the left; disposable session cards to the right of it, on the same time axis. A long history-search session and a quick answer session overlap in parallel; a second reply to the same target message coalesces into the running session instead of spawning a twin; a same-sender follow-up folds into the long session mid-run; and a later reply to a bot message resumes the completed session on the same rollout." src="docs/swarm-light.svg" width="880">
  </picture>
</p>

Each concurrent session sees the timeline as it stood when it started, is told about the other active sessions, shares no mutable state, and delivers messages that immediately appear on the timeline for its siblings to see.

This is also why there is no subagent mechanic: every session already is one, in effect. A question that takes a hundred tool calls runs in its own parallel rollout without stalling anything else, and the session keeps the full chat context that a spawned subagent would lack. For the kinds of requests a room actually makes, seeing the whole conversation usually matters more than delegation.

---

## How it works

### Context assembly

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/context-dark.svg">
    <img alt="One agent session's context, assembled from the chatroom at spawn: system prompt, diary, hierarchical summaries, a compact tier and a rich tier of chat messages, the satellite runtime state with tail instructions, and the trigger message, followed by the session's own rollout. Colored brackets map each tier to the span of chat messages it covers; older chat fades upward into the summaries." src="docs/context-light.svg" width="958">
  </picture>
</p>

Each session's prompt is **built once, at creation, and is append-only thereafter**, never rebuilt per turn. That makes the prefix byte-stable (cache-friendly), coherent (the session sees the world as it was when it started), and a clean base for persistence and resume. The build is a deterministic, token-budgeted, tiered layout. The determinism ensures that although the initial context is constructed for each session, different sessions that are started in a short timeframe will share nearly all of the prefix tokens for the KV cache.

The summary layer implements [lossless context management](https://papers.voltropy.com/LCM): aging history is never dropped; it is absorbed into rolling hierarchical summaries, coalesced into higher levels as it ages further, and expandable back out by the agent on demand. A room conversation can therefore continue indefinitely under bounded context, with the agent always seeing the complete history of the room since it joined, at high resolution for recent messages and progressively lower resolution for older ones. The paper's authors themselves wrote an OpenClaw plugin implementing it, [lossless-claw](https://github.com/martian-engineering/lossless-claw). MikuSwarm reimplements the idea natively, with the chat timeline as the substrate instead of user/assistant turns, which buys a few things:

- **Message-level granularity.** Summarization boundaries can fall between any two chat messages, and every summary is labeled with the exact timespan of the messages beneath it (the date ranges in the diagram), so the agent can place summarized events in time and the recap/search tools can select summaries by coverage. An OpenClaw bot instead receives recent chat pasted into a single user turn as text, where individual messages can no longer be separated.
- **A compact tier between the summaries and the live window.** Messages aging out of the rich tier shed their XML envelope, IDs, and metadata, get truncated if very long, and are re-rendered as plain chatlog lines: username, time, text, captions and link-preview text. They stop being interactive (without IDs the agent cannot reply to them, react to them, or inspect them with tools), but they cost a fraction of the tokens while preserving conversational continuity.
- **In-line expansion.** The upstream plugin uses dedicated subagents to expand summaries back out. MikuSwarm's sessions are focused enough to call the recap and history-search tools themselves, so the past arrives in the same context that will do the answering, with the full persona and conversation in view, with no blank-slate subagent paraphrasing old logs in between.

**Every budget has a max and a target.** Summaries coalesce by fan-in (a configurable number of level-N summaries becomes one level-N+1 summary, each of them produced under its own token cap), while the compact and rich tiers are bounded by measured token budgets, so context size has a hard ceiling no matter how long a channel runs. Crucially, each tier bound is a pair: when a tier reaches its max it is drained down to a lower target, and the drained messages flow backward into the tier behind it. A max-only bound would sit at the ceiling forever and shift the prefix on every message (the naive chatbot that drops its oldest message once full never hits prefix cache again). Draining to a target makes compaction events rare, keeps every tier's prefix byte-stable between them, and ensures each flush into the summary layer carries enough messages to seed new L1 summaries. The layout ages gracefully for the cache in general: the oldest context is held by the highest-level summaries, which change the least, and the churn (new messages, interleaved reaction events) is confined to the volatile end.

**The satellite block.** Everything highly variable lives in a satellite block inserted after the chat context and before the trigger group: auto-retrieved memories, the current time and channel, and harness state such as the sibling sessions running in parallel. Because it sits past the end of the stable prefix, all of that per-session state can vary freely without invalidating a cached byte. Most agent stacks have no natural place for such a block; it exists here because context is *constructed* per session, a movable tail rather than an accumulating log. The satellite also restates the operator's tail instructions (TAIL.md) verbatim: attention is U-shaped over long contexts, and a long chat history tends to wash the system prompt out of the model's behaviour, so the rules that most need holding are repeated in the strongest position available, directly above the messages the session is about to answer. The trigger messages come last, which sets them apart without any instruction to focus on them exclusively; a persona bot should read the whole room, and is free to answer something else too.

All of it is frozen at spawn; the rollout that follows only appends. Sessions are short-lived enough that their own tool calls and reasoning are never compacted or rewritten (a session that somehow outgrows its budget simply fails, a rare edge case), which keeps the agent-side context shaped like what the model was trained on instead of trimming thinking and tool call blocks. A resumed session appends the chat it missed plus a reduced satellite as part of the new turn. See [ARCHITECTURE.md §9 / §9a](ARCHITECTURE.md).

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

Most triggers are human: a mention, a reply to the bot, a DM. With the opt-in proactive scheduler the bot can also open sessions on its own cadence and decide for itself whether the room warrants an unprompted post, which gives it a bit of a life of its own.

### Memory

Four cooperating subsystems are implemented for recalling the bot's own history and the room's past:

- **Hierarchical summarization**: aging history is condensed into multi-level summaries (summaries of summaries, unlimited depth), produced by background sessions sharing the persona.
- **First-person diary**: a background worker journals what happened, in the bot's own voice, so recent memory reads naturally back into context. Aside from using the bot's own voice, the main difference from the summaries is that the agent writing diary entries is instructed to only include interactions of the bot with the room, not the room's internal chatter unrelated to the agent. Where the summaries are a neutral record of the room's history, the diary is a personal record of the bot's own activities in it.
- **Hybrid retrieval**: semantic + keyword (BM25) search over the bot's memory files, with temporal decay; relevant memories are auto-retrieved into the final turn within the satellite block (cache-free) or fetched on demand via a tool.
- **Chat-history search & recap**: full-text search over the actual message history across rooms, plus a "what did I miss" recap that detects an absence gap for a specific user and returns the finest available summaries for the period the user was absent. This allows users to ask the bot to catch them up on a room they haven't been in for a while, or to find a past conversation without having to scroll through the timeline themselves.

See [ARCHITECTURE.md §9b–§9e](ARCHITECTURE.md).

### Enrichment & captioning

Persisted events are enriched out of band: attachments and linked media are downloaded, replies resolved, link previews fetched, X.com posts expanded. A separate caption worker pool describes images, video, and audio with a multimodal model (animated images are converted to short video clips first). Context build waits only as long as it must for the readiness it needs. See [ARCHITECTURE.md §7a](ARCHITECTURE.md). Captioning is by default only performed on media that is part of a message the bot is replying to, but can be configured to caption all media in a room. The agent can use a captioning tool to request a caption for any media in the room, which will be generated by the captioning workers and added to the timeline, as well as returned to the agent in the same session as a tool call result.

### Tools

The toolkit is aimed at letting the bot do the same things the humans in the room can do from their own computers: look something up, poke at a website, run code, post an image. Up to ~39 tools are available to a chat session: chat actions (`send_message`, `react`, `edit_message`, polls, pins, profile), web search/fetch, a **real stealth browser** (one persistent identity with shared cookies/logins, driven via an accessibility snapshot), a **Docker shell sandbox** for `bash`/`search_files`, file editing in a sandboxed workspace, media analysis, image generation, memory read/write, and remote **MCP** servers (the default ships keyless Exa web tools, no API key needed). Niche add-ons (`danbooru`, character cards, SauceNAO reverse-image lookup, X search) are gated off by default. See [ARCHITECTURE.md §10 / §11a / §11b](ARCHITECTURE.md).

### Cost & budget limits

Spend is bounded at three levels: a **per-session** USD ceiling (with a soft agent-facing warning before a hard cutoff), **period** limits (rolling/calendar windows over a unified usage ledger), and **per-user** limits with per-user model selection. Token usage comes from the providers' own usage reports rather than local estimates. The per-user limits rules engine is extremely flexible and allows for almost any reasonable policy. It includes the ability to degrade the agent to use cheaper models for specific users, or whenever a user exceeds their personal limit for a given time period. It can also do the opposite, making the agent respond with more expensive models in specific channels or to specific users. See [ARCHITECTURE.md §8d–§8g](ARCHITECTURE.md).

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/console-leaderboard-dark.png">
    <img alt="The console's Usage & Cost page: spend cards and a stacked spend-over-time chart, every configured period limit with its headroom bar, per-user limits, and a ranked user leaderboard with per-user spend cards and a System &amp; self breakdown." src="docs/console-leaderboard-light.png" width="880">
  </picture>
</p>

### Observability console

An optional in-process HTTP + SSE console exposes the bot's internals: the durable record of every session (frozen context snapshot + full transcript), a live stream of a running session's events (including tentative tokens during inference retries), the LLM scheduler's state, and a preview of exactly what context the *next* session in any room would build. It is read-only except for a few operator actions (stop / resume / retry). See [ARCHITECTURE.md §11](ARCHITECTURE.md).

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/console-pipelines-dark.png">
    <img alt="The console's pipeline monitor on the captioning pool: the four background pools with their queue counts and spend, the list of captioning jobs with their generated captions, and a detail pane showing one image, its caption, the model, and token/cost usage." src="docs/console-pipelines-light.png" width="880">
  </picture>
</p>

### Native Rust Matrix module

The Matrix transport is a Rust NAPI module built on `matrix-sdk`, handling end-to-end encryption, media download/decryption, custom emoji, and link previews. See [ARCHITECTURE.md §6](ARCHITECTURE.md).

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
