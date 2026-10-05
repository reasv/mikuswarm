---
name: sessions
description: "Coordinate across agent sessions and look up what earlier sessions found or did. Load when: multi-session coordination is needed (`delegate_to_session`, `spawn_session`); or when asked what you found earlier, where you got something, or whether you already did a task (`read_session_record`, `read_session_transcript`)."
tools:
  - delegate_to_session
  - spawn_session
  - read_session_transcript
---

# Session Coordination and Records

You are one short-lived session; others may run in parallel (see
`<active_sessions>` in your runtime state). Earlier sessions leave compact
records you can look up.

## Session Records

Bot messages carry an `agent_session_id` XML attribute. Use it with these tools
to answer questions like "what did you find earlier?" or "have you looked into X?".

### `read_session_record` (always loaded)
Returns the session record: a summary of what was found or done, key sources,
and open threads. Use this first — it is fast and bounded in size.

```
read_session_record(session_id: "<agent_session_id from message>")
```

If the session did no tool work there will be no record; the response says so.
Follows a `builds_on` chain automatically (each record lists prior session IDs
it extends — call `read_session_record` for each to trace the full chain).

### `read_session_transcript` (enabled by this skill)
Returns the raw tool-call rollout for a session. Slower and larger — use it
only when the record is not enough and you need to see specific tool calls.

```
read_session_transcript(
  session_id: "<id>",
  query: "keyword",     // optional — filter by tool name / args / result text
  range: [1, 5],        // optional — inclusive [first, last] turn (1-indexed)
)
```

## `delegate_to_session`
When your trigger is really part of a task another ACTIVE session is already
handling (visible in `<active_sessions>`), delegate to it instead of answering
in parallel — it folds your trigger into that session and you finish without
replying. Don't delegate to yourself; don't delegate when a direct answer is
faster.

## `spawn_session`
Start a detached background session with an instruction — for work that should
outlive this reply (a long research task, a delayed follow-up). The spawned
session runs on its own; you won't see its output. Say what you kicked off in
your reply so the channel knows.
