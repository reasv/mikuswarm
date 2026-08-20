---
name: shell
description: Run shell commands in your sandboxed Linux container via the `bash` tool — scripting, file inspection/processing in the workspace, downloads, and whatever is installed in the sandbox image. Load for any task that wants a command line.
tools:
  - bash
---

# Sandbox Shell

`bash` executes commands in an isolated Linux container. Your workspace is
mounted read-write inside it, so files you create there are visible to the file
tools and vice versa.

- One call = one command (with `&&`/pipes as needed); state like `cd` and
  variables does NOT persist between calls — use absolute paths.
- Output is size-capped; page or filter (`head`, `grep`, `wc`) instead of
  dumping big files.
- Long-running commands hit the exec timeout — background daemons won't
  survive; chunk work into bounded steps.
- Network access follows the deployment's sandbox policy; failures to reach a
  host may be firewall policy, not an error in your command.
- Prefer the dedicated tools where they exist (file editor for edits, media for
  downloads) — the shell is the general-purpose fallback.
