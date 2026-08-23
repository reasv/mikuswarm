# Workspace Template Reconciliation — rolling out template additions to established workspaces

**Status**: IMPLEMENTED — superseded by ARCHITECTURE.md §4b; retained for review. Post-design addition: cross-source collision guard (first-source-wins on physical path overlap, warn+skip); not in this spec but implemented in the landing commit.

**Owner decisions (2026-08-23)**: implement now. `update_unmodified` defaults
**on** in v1 — an owner override of the draft's off recommendation: the hash
gate itself, not the knob, is the safety contract (§5.4). The remaining §12
questions resolve per the draft's recommendations: default mode `reconcile`;
adoption-boot absences seed loudly; drift notices are logs-only in v1; no
persona-file special case.

**Author**: design session 2026-08-23.

Target ARCHITECTURE.md home once implemented: §4b (retitled "Workspace seeding
& template reconciliation" — the first-run text becomes the `first-run` mode of
the new mechanism), §6 (storage: the `workspace_seed_ledger` table + schema
version bump), §4 (the `[seeding]` config block), §14 (invariant amendment:
the never-overwrite invariant restated in its reconcile-aware form).

---

## 1. Problem

First-run seeding (`src/bootstrap/seed.ts`, ARCHITECTURE.md §4b) populates an
**empty** workspace from `templates/workspace/` and then never touches it
again: `seedWorkspace` is gated on the workspace having neither `AGENTS.md`
nor `SOUL.md`. The gate is correct for what it defends (never partially seed
into, let alone clobber, a live workspace) but it has a growth problem:

**an established deployment never receives new template content.** When a
release adds a workspace skill (a new `skills/<name>/SKILL.md`) or extends the
shared docs (`TOOLS.md`, `AGENTS.md` template text), every deployment that has
already booted once gets the new *code* on upgrade but not the new *workspace
files*. The tools exist; the skill that activates them does not. Under dynamic
tool loading (spec/DYNAMIC-TOOL-LOADING.md) this is fatal to the feature: a
tool whose skill file is absent from the workspace is undiscoverable — per the
project's own activation rule, a tool the agent doesn't reliably reach does
not exist.

This bit concretely during the cross-channel-messaging rollout
(spec/CROSS-CHANNEL-MESSAGING.md): the new `skills/contacts/` skill and the
`TOOLS.md` lookup-table additions had to be hand-copied into each established
workspace. The graft needs care, because live workspace files are not pristine
template copies: the agent edits its own files by design (memory, TOOLS.md
notes, personal conventions), and operators carry local edits. A blind
overwrite is destructive; there is currently no supported path at all.

Two adjacent defects fall out of the same analysis:

- `seedFeatureSkills` has **no** emptiness gate — it copy-missing-seeds into
  established workspaces on every boot. So feature skills *do* roll out today,
  but with a live hazard: a feature skill file the operator or the agent
  deliberately **deleted** is silently resurrected on the next boot. There is
  no way to distinguish "never had it" from "removed it".
- Nothing tells the operator when a template file they have local edits to
  (`TOOLS.md` being the canonical case) has changed upstream. Updates to
  shared docs are invisible; deployments drift with no signal.

## 2. Goals and non-goals

Goals:

1. **New template files reach established workspaces** automatically on boot
   after an upgrade — the `contacts` case needs zero manual steps next time.
2. **Never destroy local content.** No file whose current bytes differ from
   what this mechanism itself wrote is ever modified or deleted. Agent edits,
   operator edits, and persona files are untouchable.
3. **Never resurrect deliberate deletions.** A template-originated file that
   the operator or the agent removed stays removed (fixes the live
   `seedFeatureSkills` hazard too).
4. **Observable.** Every file created is logged; upstream changes to locally
   modified files surface as an explicit drift notice with actionable merge
   guidance.
5. **Generic and deployment-agnostic.** One mechanism, no deployment-specific
   behavior, safe defaults for every deployment.

Non-goals:

- **No automatic merging** of upstream changes into modified files. Merge
  remains a documented manual convention (§8). Auto-copy happens only for
  files provably unedited since the mechanism wrote them (§5.4); anything
  with local edits gets a notice, never a write.
- **Config seeding is out of scope.** `seedConfigDir` stays first-run-only:
  config files are operator-owned from the moment they exist, and shipped
  defaults already roll out via the baked `00-defaults.toml` merge layer.
- **No agent-facing tools.** This is a boot-time operator mechanism; the
  CLAUDE.md activation-design requirements are satisfied vacuously (§9).
- **No template-file deletion propagation.** A file removed from templates
  upstream is never deleted locally (logged once, §5.5).

## 3. Design overview

Replace the all-or-nothing emptiness gate with a **per-file reconcile driven
by a persistent seed ledger**. The ledger records, per agent workspace and per
template-relative path, that *this mechanism* placed (or observed) that file
and which template version (content hash) it corresponds to. With that one
piece of memory, every case becomes decidable:

| Ledger row | Local file | Meaning | Action |
|---|---|---|---|
| absent | absent | genuinely new template file | **seed it** + record |
| absent | present | pre-ledger file (established workspace, manual graft, or crash between copy and record) | **adopt**: record silently, never touch content |
| present | absent | deliberately deleted | **tombstone**: skip forever |
| present | present | tracked file | compare hashes → no-op, drift notice, or (opt-in) safe update (§5.3) |

The ledger lives in the deployment SQLite database (§6) — deliberately
*outside* the workspace, because the workspace is agent-writable (file tools +
the sandbox bind mount) and the ledger must not be editable, deletable, or
even visible from inside it.

`seedFeatureSkills` routes through the same reconcile with a per-feature
source prefix, gaining tombstones (and losing the resurrection hazard) for
free.

## 4. Configuration

New top-level block (global — seeding policy is deployment-wide, not
per-agent; the reconcile itself runs per agent workspace):

```toml
[seeding]
# "reconcile"  — ledger-driven per-file reconcile (proposed default, §12 Q1)
# "first-run"  — exact current behavior: emptiness-gated seedWorkspace +
#                ungated copy-missing seedFeatureSkills; ledger not consulted
# "off"        — no workspace/feature seeding at all (config seeding unaffected)
mode = "reconcile"

# Third tier (§5.3/§5.4): when a template file changed upstream AND the local
# copy is still byte-identical to the template version last recorded in the
# ledger (provably never locally edited), copy the new version over it.
# Default ON (owner decision 2026-08-23): provably non-destructive, and it is
# what lets pure-doc template fixes roll out with zero manual steps. Set to
# false to restrict the mechanism to creating new files only.
update_unmodified = true
```

Schema: TypeBox `StrictObject`, both fields optional with the defaults above;
`mode` a `Type.Union` of the three literals. Validation has no cross-field
concerns. `update_unmodified` is meaningful only under `mode = "reconcile"`
(ignored otherwise; not an error).

## 5. Reconcile algorithm

Runs where seeding runs today (`startMikuAgent`, after `Storage.open` — which
already precedes both call sites — and before any provider starts or session
can run, so no agent write races the reconcile). In agents mode, once per
declared agent with that agent's `workspace_root` and name; in legacy mode,
once with the `__legacy__` sentinel (matching `agentWorkspaceMap`).

Inputs: the template source trees, each with a **source id** —
`"workspace"` for `templates/workspace/`, `"feature:<name>"` for each enabled
feature's `templates/features/<name>/skills/` (destination `<root>/skills/`,
unchanged). Disabled features are not reconciled (unchanged from today:
turning a feature off never removes its files; turning it on later seeds
missing ones — now tombstone-aware).

For every file in a source tree, with posix-style path `P` relative to the
destination root and template content hash `T` (SHA-256 of bytes):

1. **Load** ledger row `R` for `(agent, P)`; stat local `<root>/P`.
2. **No row, no local file → seed.** Copy with `COPYFILE_EXCL` (the existing
   kernel-enforced never-overwrite primitive; `EEXIST` → treat as case 3 with
   a freshly-appeared file, i.e. adopt). Insert row `(origin='seeded',
   template_hash=T)`. Log info per file: `seeded new template file`
   `{agent, path, source}`.
3. **No row, local file exists → adopt.** Insert row `(origin='adopted',
   template_hash=T)` without reading or comparing local content. Debug log
   only. This is the bulk one-time case on an established workspace's first
   reconcile boot, and also self-heals a crash between copy and record.
   Adoption is deliberately silent even when local content differs from the
   template — flagging every persona file and locally-annotated doc on
   adoption boot would be pure noise; drift tracking starts from the *next*
   template change.
4. **Row, no local file → tombstone.** Skip. If `T != R.template_hash`,
   update the row's hash silently (the tombstone tracks upstream so a later
   un-deletion decision compares against current). Debug log.
5. **Row, local file, `T == R.template_hash` → no-op.** (The overwhelmingly
   common steady-state; local content is *not* hashed in this case, so the
   steady-state boot cost is one stat per template file.)
6. **Row, local file, `T != R.template_hash` → template updated upstream.**
   Now hash the local file → `L`:
   - `L == T`: operator already applied the new version by hand → update row
     silently.
   - `L == R.template_hash` (local still byte-identical to the last template
     version this mechanism recorded → provably never locally edited):
     - `update_unmodified = true` → **safe update**: write new content via
       temp-file + atomic rename, update row, log info
       `updated unmodified template file` `{agent, path, old, new}`.
     - else → **drift notice** (§7), tagged `local: "unmodified"` so the
       operator knows a plain copy is safe; update `R.template_hash = T`.
   - otherwise (locally modified) → **drift notice** (§7) tagged
     `local: "modified"` — manual merge required (§8); update
     `R.template_hash = T`.

Updating `R.template_hash` in the notice branches is the acknowledgment
model: each upstream change to a given file produces its detailed notice
**once**, on the first boot at the new template version (see §7 for why
not-per-boot).

**Invariant (restates and strengthens the §4b invariant):** the mechanism
never deletes anything, and never writes to an existing path unless
`update_unmodified` is on *and* the current local bytes hash-match the
template version the ledger itself recorded. With `update_unmodified = false`
it only ever creates files at paths that neither exist locally nor appear in
the ledger; the default (on) additionally performs that hash-gated update of
provably-unedited files and nothing else. Failure posture is unchanged: every step fails safe — errors logged
and swallowed, startup continues; ledger writes go through the storage
single-writer queue; a row is written only after its copy succeeds.

### 5.1 First reconcile of a pre-mechanism established workspace

On the first `reconcile` boot of a workspace that predates the ledger, every
existing file adopts silently (case 3). Template paths **absent** locally are
ambiguous — "added upstream while this deployment aged" vs "deleted before
the ledger existed" are indistinguishable. Proposed resolution: **seed them**
(case 2), loudly, one info line per file. Rationale: this is exactly the
motivating scenario (the new skill must arrive), template-file deletions are
rare, every creation is individually logged, and a re-deletion is then
tombstoned permanently — the cost of a wrong guess is one visible file the
operator deletes once. The conservative alternative (adoption-boot absences
become tombstones) is listed as §12 Q2 because it silently defeats the
mechanism's purpose for the upgrade that introduces it.

### 5.2 Renames upstream

A template file renamed upstream appears as: old path → case 4-ish (row
present, local present, template gone — see §5.5) and new path → seed. The
old local file is never removed; the release notes should call out renames.
Accepted limitation.

### 5.3 Why "unmodified" is decidable without a local-hash column

The seeded/updated content always equals a template version whose hash the
ledger recorded. So "never locally edited" ⇔ `hash(local) ==
R.template_hash`. Adopted-divergent files (persona files, annotated docs)
never satisfy it and can never be auto-updated, by construction.

### 5.4 The `update_unmodified` tier

Provably non-destructive (it only replaces bytes identical to a template
version it shipped), and it is what makes pure-doc template fixes (typo in a
SKILL.md the agent never touched) roll out automatically. The draft proposed
default-off for v1; the owner decided (2026-08-23) it ships **on**: the
safety contract is the hash gate itself, and shipping it off would strand
doc updates on every deployment that never finds the knob. `false` remains
available to restrict the mechanism to file creation only.

### 5.5 Files removed from templates upstream

Ledger rows whose path no longer exists in any active source tree: leave the
local file and the row; log once (info, on the transition — detectable
because the row exists but no template file was walked) that the file is no
longer shipped upstream. No deletion, ever. Note: a feature being *disabled*
also makes its rows unwalked — the transition log must therefore say
"unshipped or feature-disabled" and must not fire repeatedly (track via a
`last_seen_at` touch per walk, compare against the previous walk's stamp, or
simply log at debug — resolution left to implementation).

## 6. Storage

New table (schema version bump + migration per the standard §6 process,
including the `LATEST_SCHEMA_VERSION` assert convention):

```sql
CREATE TABLE workspace_seed_ledger (
  agent_name    TEXT NOT NULL,   -- '__legacy__' in legacy mode
  rel_path      TEXT NOT NULL,   -- posix-style, relative to the destination root
  source        TEXT NOT NULL,   -- 'workspace' | 'feature:<name>'
  origin        TEXT NOT NULL,   -- 'seeded' | 'adopted' | 'updated'
  template_hash TEXT NOT NULL,   -- sha256 hex of last-seen template content
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (agent_name, rel_path)
) WITHOUT ROWID;
```

Tombstone is *row present + file absent* — no flag column. All writes go
through the single-writer queue. The ledger is keyed by **agent name**, not
workspace path, so a relocated volume keeps its history; renaming an agent in
config orphans its rows and re-adopts under the new name (documented,
acceptable — adoption is lossless for content).

Why the DB and not a file: a JSON manifest inside the workspace would be
agent-readable/writable/deletable (file tools and the sandbox bind-mount the
workspace root) — corruptible state and prompt-surface pollution; a manifest
beside the DB duplicates persistence machinery the storage layer already
provides (single-writer, migration, backup story). `seed.ts` stays free of a
hard storage dependency by taking a minimal ledger interface (get/upsert/list
for one agent) that `app.ts` wires from `Storage`; `first-run` mode and
`seedConfigDir` (pre-config, pre-storage) never touch it.

## 7. Observability

- **Per-file info logs** for every mutation: `seeded new template file`,
  `updated unmodified template file` (each with agent, path, source).
- **Drift notices** (info, structured): `template file changed upstream`
  `{agent, path, source, local: "modified"|"unmodified", old_hash, new_hash,
  hint}` where `hint` names the manual-merge convention (§8). Emitted **once
  per (path, new template version)** — the ledger-hash update is the ack.
  Re-emitting every boot was considered and rejected: with no operator-ack
  channel it nags forever on legitimately-diverged files (every persona file
  would flag on every boot for every deployment after any template touch),
  which trains operators to ignore the signal entirely.
- **Per-boot summary** (info, one line per agent, only when anything
  happened): `workspace reconcile: N seeded, U updated, D drift notices, K
  tombstones skipped`.
- Console exposure (a drift panel on the agents view) is explicitly future
  work, not v1.

## 8. Manual-merge convention (documentation deliverable)

For a drift notice with `local: "modified"` the operator merges by hand. The
convention, to be documented in the ARCHITECTURE.md §4b successor section
(operator-facing, describing shipped behavior — so it lands with the code):

1. The notice's `old_hash`/`new_hash` identify template versions; templates
   are committed, so the base is in git history:
   `git log --oneline -- templates/workspace/TOOLS.md` /
   `git show <rev>:templates/workspace/TOOLS.md`.
2. Three-way merge into the live file:
   `git merge-file <live-file> <base-from-old-rev> templates/workspace/<path>`
   (or hand-apply the diff `git diff <old-rev> <new-rev> -- templates/...`).
3. Live-file edits always win on conflict — template text is the suggestion,
   the workspace is the agent's/operator's.

Releases that change shared workspace docs should say so in `CHANGELOG.md` so
operators expect the notice.

## 9. Agent-facing surface & activation (CLAUDE.md compliance)

This feature adds **no agent-facing tools** and no always-on prompt text; the
activation-design checklist applies vacuously. What it *changes* for the
agent: newly seeded `skills/*/SKILL.md` files appear before the skills index
is built for any session (reconcile completes before providers start), so a
new skill's own activation design — its description line in the per-session
skills index — takes effect on the first post-upgrade boot with no manual
step. That is the entire point: this mechanism is the missing transport for
every future spec's activation plan. The ledger itself is invisible to the
agent (outside the workspace); no workspace dotfiles are introduced.

## 10. Testing

Unit tests (`test/seed-reconcile.test.ts`, temp dirs + in-memory ledger stub;
plus storage-backed ledger tests with the real migration):

- fresh empty workspace: reconcile result byte-identical to today's first-run
  seeding; ledger fully populated with `origin='seeded'`.
- established-workspace adoption: nothing modified, rows `adopted`, absent
  template paths seeded and logged (§5.1).
- tombstone: seed → delete local → reconcile → not recreated; template update
  on a tombstoned path stays silent.
- new-file rollout: add template file between reconciles → created + logged.
- drift: modify local, bump template → notice once, not on next boot;
  `unmodified` vs `modified` tagging; pre-applied update (`L == T`) silent.
- `update_unmodified`: off → notice only; on → atomic overwrite only when
  `hash(local) == recorded`, never otherwise.
- crash window: file present, no row → adopted, content untouched.
- agents mode: two agents, disjoint ledgers, one's deletion doesn't tombstone
  the other.
- feature sources: disabled feature not walked; re-enabled feature respects
  tombstones (the resurrection-hazard regression test).
- modes: `first-run` byte-identical to current behavior; `off` seeds nothing.

## 11. Rollout / migration

The migration creates an empty table only. The first `reconcile` boot on an
established deployment performs the adoption pass (§5.1) — the operator
should skim the seed/drift log lines after that boot, per §8's documentation.
No data transformation, no config required (defaults apply), `mode =
"first-run"` is the escape hatch to exact pre-change behavior.

## 12. Open questions — resolved (owner, 2026-08-23)

1. **Default mode**: `reconcile`.
2. **Adoption-boot absences** (§5.1): seed them, loudly (one info line per
   file); a re-deletion is then tombstoned permanently.
3. **`update_unmodified` default**: **on** in v1 — owner override of the
   draft's off recommendation (see §5.4).
4. **Drift-notice surface**: logs-only in v1; the console drift panel stays
   future work.
5. **`SOUL.md` exemption**: none — adoption-boot seeding of the placeholder
   is accepted (individually logged, harmless).
