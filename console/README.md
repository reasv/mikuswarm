# miku console

The observability & admin console for **mikuswarm** — a SvelteKit app that renders,
with byte-for-byte fidelity, the context each room would build and the full input +
rollout of each session (see `../ARCHITECTURE.md` §11).

## Architecture (BFF)

The agent's read API is **in-process** with the agent runtime (it needs the live
`ContextBuilder.build()`, the in-memory `Agent.subscribe()`, and the single-writer
queue — spec §8). A SvelteKit app can't share that process's memory, so this console
runs as a **separate Node process acting as a typed BFF/proxy** in front of it:

```
browser ──(same-origin, no token)──▶ SvelteKit BFF ──(Bearer token)──▶ agent in-process API
   Svelte 5 + shadcn-svelte             remote functions (Effect)         (unchanged)
   + TanStack Query                     + Effect Schema decode
```

- **Remote functions** (`src/lib/api/*.remote.ts`) are the typed client/server boundary:
  `query` for reads, `command` for admin actions. Their bodies are **Effect** programs
  (`src/lib/server/api/`) that proxy the agent API and decode every response with
  **Effect Schema** (`src/lib/schemas.ts`) — a wire-shape drift surfaces as a
  `DecodeError` at the BFF, not a silent UI bug.
- **Live streams are NOT remote functions.** The session rollout stream and the pipeline
  activity firehose are same-origin **SSE proxy routes** (`src/routes/api/sessions/[id]/
  stream/+server.ts`, `src/routes/api/pipelines/stream/+server.ts`) that pipe the agent's
  event-stream bytes verbatim; the browser parses the records itself (`src/lib/sse.ts` +
  `src/lib/api/live.ts`). `query.live` cannot carry them: SvelteKit live queries are
  latest-value channels that drop intermediate values under backpressure ("live streams
  are not event logs"), and the rollout fold / activity listener need every event.
- **TanStack Query** is the single client-side cache/invalidation authority; it wraps the
  non-streaming remote queries. The SSE streams are consumed directly, outside TanStack.
- The bearer token lives only in `src/lib/server/config.ts` (`$env/dynamic/private`); it is
  never sent to the browser. All upstream hops are server→server, so there is no CORS.

## Run it

1. **Enable the agent's API.** In the agent's local config:
   ```toml
   [observability.server]
   enabled = true
   bind = "127.0.0.1"
   port = 8799
   auth_token = "${MIKUSWARM_CONSOLE_TOKEN}"
   ```
   Export `MIKUSWARM_CONSOLE_TOKEN` and start the agent (`npx tsx src/index.ts`).

2. **Run the console** (separately, like the native module — it builds on its own):
   ```sh
   cd console
   cp .env.example .env        # set MIKUSWARM_CONSOLE_API_URL + the same MIKUSWARM_CONSOLE_TOKEN
   pnpm install
   pnpm dev                    # dev server
   # or, production (adapter-node) — note `node` does NOT read .env itself:
   #   pnpm build && node --env-file=.env build/index.js
   ```

   > **Production gotcha — mutating buttons 403 ("Cross-site remote requests are
   > forbidden").** Under `pnpm dev` SvelteKit skips its remote-function origin
   > check, but the built adapter-node server enforces it: it rejects any non-GET
   > remote `command` (the resume/abort/retry buttons) whose browser `Origin`
   > doesn't match the server's computed origin. With no `ORIGIN` set, adapter-node
   > assumes `https`, so plain-http access mismatches on scheme and every button
   > 403s while GET reads still work. Set `ORIGIN` to the exact URL you load in the
   > browser (see `.env.example`); behind a TLS proxy use `PROTOCOL_HEADER`/
   > `HOST_HEADER` instead. `node` won't read `.env` on its own — pass
   > `--env-file=.env` or export the vars.

## Demo mode (fixtures, no live agent)

To render the real console UI against curated, non-sensitive **fake** data — for
screenshots, demos, or frontend dev without a running agent + populated DB — set
`MIKUSWARM_CONSOLE_DEMO=1` and skip step 1 entirely:

```sh
cd console
MIKUSWARM_CONSOLE_DEMO=1 pnpm dev
# then open http://localhost:5173
#   /usage-cost                                  → Cost & Budget view
#   /?room=matrix%3Aaria%3Aroom%3A%21general%3Amatrix.example.org&session=ses_op4kq2  → session observability
```

Demo mode swaps the BFF's `AgentApiClient` for a fixture-backed layer (spec
`CONSOLE-DEMO-MODE`), so `MIKUSWARM_CONSOLE_API_URL` / `MIKUSWARM_CONSOLE_TOKEN` are
ignored and no agent is contacted. Every fixture is invented (`matrix.example.org` ids,
invented chat) and is decoded through the same Effect Schema as real responses, so it
can never drift from the wire shape. It's read-only — the admin buttons are inert.
Default off: without the flag the console behaves exactly as before.

## Scripts

- `pnpm dev` / `pnpm build` / `pnpm start` (`node build/index.js`)
- `pnpm check` — `svelte-check`
- `pnpm test` — Vitest (BFF schema/SSE/rollout unit tests)

## Layout (spec §11)

Four zones: **Col 1** rooms (top) + sessions (bottom); **Col 2** room context (verbatim,
§10a) or session input (§10a) + rollout (§10b); **Col 3** session inspector (the raw
record behind the selected session — ids, timing, token/cost breakdown, tool-invocation
ledger, context-dump path, raw JSON).

## shadcn-svelte components

`init` was done by hand (the CLI's design-system *preset* step is interactive-only and
can't be driven non-interactively). Components are vendored from the registry via
`scripts/vendor-shadcn.py`; `components.json`, `src/lib/utils.ts`, and the zinc theme in
`src/routes/layout.css` are the equivalent of what `init` writes. Re-run the script to add
more components.
