---
name: sessions
description: Coordinate across agent sessions — hand this trigger over to a session already working on the same thing (`delegate_to_session`) or spawn a detached background session for long side-work (`spawn_session`). Load only when multi-session coordination is actually needed.
tools:
  - delegate_to_session
  - spawn_session
---

# Session Coordination

You are one short-lived session; others may run in parallel (see
`<active_sessions>` in your runtime state).

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
