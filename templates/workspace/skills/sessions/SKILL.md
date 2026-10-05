---
name: sessions
description: "'Where did you get that?', 'what did you do in that session?', 'what did you find earlier?', 'did you already look into X?': what an earlier session of yours found or did, from its record and raw tool calls (`read_session_record`, `read_session_transcript`). Also multi-session coordination: hand your trigger to a running session or start a background one (`delegate_to_session`, `spawn_session`)."
tools:
  - read_session_record
  - read_session_transcript
  - delegate_to_session
  - spawn_session
---

# Earlier Sessions and Session Coordination

You are one short-lived session; others ran before you and may run in parallel
(see `<active_sessions>` in your runtime state). A session that did tool work
leaves a compact record of what it found or made.

## What an earlier session found or did

Every bot message carries an `agent_session_id` attribute: on the message
itself, on a `<reply_to>` quote of it, and in `read_messages` output. That id
is the argument for both tools below. When someone asks about something you
said ("where did you get that?", "post the second one", "what was the third
link?"), take the id from that message.

### `read_session_record(session_id)`: start here
Returns the record: sources (including ones only mentioned in passing or found
but not used), artifacts (paths, message ids) and their state, open threads.
Short and bounded.

- A reply to a bot message often starts with that message's record already
  read for you (a `read_session_record` call at the top of your session). Check
  it before calling again.
- "Builds on earlier session(s): <ids>" means that session continued earlier
  ones. Each id has its own record: call `read_session_record` on it to go one
  hop back; repeat only while the answer is still missing.
- "No record" means the session did no tool work worth recording (its chat
  messages are all there is) or its record was not written; its transcript may
  still have the calls. "Still being written" means retry in a few seconds.

### `read_session_transcript(session_id, query?, range?, offset?)`: the raw calls
For what the record does not say: the exact URL, file, search, or result text.
Lists each tool call with its arguments and result.

```
read_session_transcript(session_id: "<id>", query: "arxiv")
```

- `query`: case-insensitive text matched against tool names, arguments and
  results. Long results show the passages around each match, so a term deep
  inside a big page is found. Prefer a query over listing everything.
- `range: [first, last]`: only those turns (1-indexed turns with tool calls).
- `offset`: the response is bounded; when it ends with "Next page: ... offset:
  N", call again with `offset: N`.

Same visibility rules as `read_messages`: only your own sessions, and never a
session from an isolated channel you are not in.

## `delegate_to_session`
When your trigger is really part of a task another ACTIVE session is already
handling (visible in `<active_sessions>`), delegate to it instead of answering
in parallel; it folds your trigger into that session and you finish without
replying. Don't delegate to yourself; don't delegate when a direct answer is
faster.

## `spawn_session`
Start a detached background session with an instruction, for work that should
outlive this reply (a long research task, a delayed follow-up). The spawned
session runs on its own; you won't see its output. Say what you kicked off in
your reply so the channel knows.
