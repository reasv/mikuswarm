# OpenAI Responses API Prefill

**Status**: IMPLEMENTED -- superseded by ARCHITECTURE.md "Model-scoped OpenAI prefill"; retained for review.

**Contributor credit**: Problem analysis and captioning code from GitLab MR adhyc/mikuswarm!1 (contributor: nopm). The analysis-as-tool-argument design and all implementation in this file are a redesign for MikuSwarm, replacing the MR's grammar/wrapper approach.

## Problem

GPT-6 Sol and Luna refuse to answer as the bot's persona under normal prompting. A structured response prefix forces the model to re-reason in a controlled format before acting: it starts every tool call with an analysis of what to do, which anchors persona adherence.

## Contract

`[models.<name>.prefill]` with `enabled = true` and `text = "We must "` activates the feature for that model. Validation requires:
- `text` non-empty
- `provider = "openai"`
- `api = "openai-responses"`

`enabled = false` disables an inherited setting.

`tools` (optional string array): restrict the analysis argument to a subset of tools; absent = all tools including `no_reply`.

`drop_reasoning` (bool, default false): strip native thinking blocks from outgoing assistant history (wire only; frozen snapshots are not mutated) and from stored completed responses.

## Wire format

Every function tool's parameters schema is transformed to strict-compatible form and gets `analysis: { type: "string", pattern: "^<escaped prefix>[\\s\\S]*" }` as its first required property with `strict: true`. `tool_choice` is set to `"required"`. The `no_reply` tool (only in prefill-enabled sessions) allows the model to signal silence without calling send_message.

The transform is applied per serving fallback member (not per chain head) via the `onPayload` hook. The member's `compat.prefillText` carries the resolved text; null means disabled. This allows a Bedrock-backed head with prefill and a direct-OpenAI fallback without it to coexist in one chain.

## Strict schema transform

`strictify(schema)`:
- All optional properties become nullable (type union with null) and are added to `required`
- `additionalProperties: false` on every object
- Removed keywords: default, format, minimum, maximum, minLength, maxLength, minItems, maxItems, examples
- Preserved: `$defs`, `$ref`, anyOf, enum, const

## Analysis argument in canonical schema

The analysis property is also added to each tool's canonical schema as optional (not required) so pi's argument validation accepts it and the transcript retains it as the model's own past function-call arguments. The `execute` wrapper strips it before forwarding to the real tool. On non-prefill fallback members the optional property is harmless (non-strict, optional, never sent).

## no_reply tool

Originally a session-scoped tool registered only when prefill was enabled; since the follow-up commit it is an ordinary catalog tool in every chat session (`src/tools/no-reply.ts`), and the prefill transform treats it like any other tool. Calling it is terminal (`terminate: true`): `isTerminallyValid` and `isExplicitNoReply` in runner.ts both recognize it. The dedup/claim/diary logic treats it identically to the legacy text-based NO_REPLY, which stays accepted but is no longer taught.

## Why not a grammar wrapper

The MR used a custom grammar tool that encoded all domain tool calls as JSON in text. That approach re-bills the entire prompt cache on every skill load (the tool definition changes every time), encodes calls out of distribution (JSON-in-text rather than native function calls), and requires a separate decoder layer. The analysis-as-argument form keeps everything native.
