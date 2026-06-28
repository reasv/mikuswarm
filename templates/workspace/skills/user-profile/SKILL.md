---
name: user-profile
description: Read and patch per-user markdown profiles under `users/<provider>/<slug>--<hash>.md` via the `user_profile_read` / `user_profile_edit` tools. Use when learning durable facts about a sender or another named user.
---

# User Profile Workflow

**Purpose:** Maintain durable per-user social memory as workspace markdown files. The tools resolve trusted runtime sender IDs to canonical paths, so you do not have to guess filenames.

## Conventions

- Canonical paths: `users/<provider>/<slug>--<hash>.md`. The hash is derived from `provider + senderId` and stays stable across display-name changes.
- Legacy paths like `users/alice__example.org.md` may still exist; the tools discover them automatically.
- Profiles use a fixed shape: YAML frontmatter (identity fields) followed by heading-based sections. Do not collapse them into one-line key/value bullets.
- The runtime layer may prepend a trusted note about whether the current sender already has a saved profile path. Treat that as a hint to call these tools, not as a reason to hand-edit filenames.

## Default Target vs. Explicit Target

- Default target is the **current requester**, resolved from trusted runtime context. No need to pass anything special.
- Explicit cross-user targets: pass `target.mode: "explicit"` plus `provider` and `senderId`. For Matrix, `senderId` is the full mxid like `@alice:example.org`.

## Read

Summary view (metadata + per-section sizes and previews):

```json
{
  "view": "summary"
}
```

Excerpt view of one section, paged:

```json
{
  "target": {
    "mode": "explicit",
    "provider": "matrix",
    "senderId": "@alice:example.org"
  },
  "view": "excerpt",
  "section": "Interests",
  "maxChars": 1200
}
```

`view: "exists"` is a cheap presence/path check that returns whether a profile file exists and at what path.

Excerpt responses include a `nextOffset` when the section was truncated, so you can page through with `offset`.

## Edit

`createIfMissing` defaults to true.

Requester-bound update with multiple ops:

```json
{
  "operations": [
    {
      "op": "append_bullets",
      "section": "Likes",
      "lines": ["likes old ThinkPads", "prefers short answers"]
    },
    {
      "op": "append_paragraphs",
      "section": "Summary",
      "paragraphs": ["Regular room participant. Often asks technical follow-ups."]
    }
  ]
}
```

Explicit cross-user replacement:

```json
{
  "target": {
    "mode": "explicit",
    "provider": "matrix",
    "senderId": "@alice:example.org"
  },
  "operations": [
    {
      "op": "replace_section",
      "section": "Facts",
      "text": "- Mentioned collecting old ThinkPads."
    }
  ]
}
```

### Supported Operations

- `set_identity_fields` — set or clear top-of-file identity values (username, displayName, etc.).
- `replace_section` — replace a heading-based section's body wholesale.
- `append_bullets` — add bullet items to a section's bullet list.
- `append_paragraphs` — append paragraph(s) to a section.
- `remove_bullets_matching` — delete bullets matching a substring or pattern.

## When to Write

- When you learn something durable about a user: preferences, recurring requests, communication style, facts they want remembered.
- Default to the current requester unless the user is talking about a third party.
- Keep entries factual and tonally neutral. The profile is a memory aid, not a judgement. Avoid anything that reads like a negative character assessment.
- Prefer small, additive `append_*` operations over wholesale `replace_section` rewrites unless a section has gone stale.
