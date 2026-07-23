# Contributing

Thanks for your interest in contributing. This is a TypeScript (ESM, run via
`tsx`) Matrix chatbot with a Rust NAPI module for the native Matrix client
(E2EE, media, link previews). This guide covers how to get set up, run the
project, and the conventions we follow.

For the overview, see the [README](README.md). For the full design reference —
data flow, invariants, context assembly, the enrichment pipeline, configuration
schema, and design decisions — see [ARCHITECTURE.md](ARCHITECTURE.md).

## Prerequisites & setup

- **Node 24** with **pnpm** via corepack: `corepack enable` (the pinned pnpm
  version is in `package.json` under `packageManager`).
- **Rust** — the toolchain is pinned in `rust-toolchain.toml`; rustup will pick
  it up automatically. Needed to build the native NAPI module.

Then:

```sh
pnpm install --frozen-lockfile   # dependencies
pnpm build:native                # build the Rust NAPI module into npm/
pnpm fetch:tokenizer             # fetch the vendored GLM tokenizer assets
```

A fresh checkout has no `node_modules` and no native binary — that's expected;
the three commands above produce both.

## Running

There is no JS build step — TypeScript runs directly through `tsx`:

```sh
npx tsx src/index.ts
```

## Checks

Run these before sending a change:

```sh
npx tsc --noEmit       # type-check only (no emit)
npm test               # unit tests, Node's built-in test runner via tsx
npm run test:docker    # Docker integration tests
```

`npm run test:docker` needs a running Docker daemon and the built sandbox image;
it auto-skips at runtime when Docker or the image is absent, so it is safe to run
without a daemon.

## Key conventions

- **No JS build step.** TS runs via `tsx`; we only type-check with
  `tsc --noEmit`.
- **All SQLite writes go through the single-writer queue** (see `src/storage/`).
  Don't open your own write path to the database.
- **Config is TOML** with deep-merge across config files, environment-variable
  substitution, and TypeBox validation.
- **Logs are structured JSON**, one object per line, with automatic secret
  redaction.
- **Tools are factory functions** that return an `AgentTool` with a TypeBox
  schema for their arguments.

## Documentation discipline

`ARCHITECTURE.md` documents only what is implemented, and it must stay in sync
with the code. If your change affects architecture, data flow, configuration,
types, tools, or invariants, update the relevant sections of `ARCHITECTURE.md`
**in the same commit**.

Design docs for unbuilt work live in `spec/*.md`. These describe *proposed*
work and are not mirrored into `ARCHITECTURE.md` until the feature actually
lands.

## Commit messages

Keep each commit message to a **single line, under 80 characters — subject
only**. No body, and no attribution or trailer lines (`Co-Authored-By`,
"Generated with …", etc.).

## Code of conduct

Be respectful and constructive in issues, pull requests, and discussion.

## License

By contributing, you agree that your contributions are licensed under the
project's [GNU AGPL-3.0](LICENSE).
