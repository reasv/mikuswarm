# Repetition guard

**Status**: IMPLEMENTED — superseded by ARCHITECTURE.md §8a "Repetition guard"; retained for review.

## Problem

Some models occasionally collapse mid-generation into an exact loop: one unit (a
character, a word, a sentence, a paragraph) emitted back to back until the output
cap. Observed cases: a Chat Completions tool call whose argument string turned into
a two-character unit repeated for ~30k characters until `max_tokens`, and a chat
reply that repeated one 129-character unit for ~19k characters. Each costs a full
`max_tokens` of output and minutes of streaming, and the result is unusable.

## Constraints

- Agent output is arbitrary: tables, code, card JSON, emoji, separators, quoted
  text. A false positive aborts a valid turn, so the detector must only fire on
  what no legitimate turn produces.
- Per model, default off: only models known to degenerate pay for the check.
- A trip is not an outage. The model is serving; one sample went bad.

## Design

**Detection: exact periodic runs only.** For each period p ≤ `max_period`, count
consecutive streamed code units equal to the one p positions earlier; any
variation resets the count. Trip when a count reaches `min_chars` and
(`min_repeats` − 1)·p. Similar-but-varying text (table rows, code lines, JSON
arrays of records) never accumulates a run. Each content block (text, thinking,
each tool call's argument stream) is watched on its own. O(`max_period`) compares
per code unit.

**Calibration.** The longest exact periodic run (period ≤ 1024) was measured in
every assistant content block of one deployment's history: about 47k blocks from
about 10 models, with tool-call arguments split into their string values. Only
aggregate numbers were inspected. Both known degenerations stood out (about 30k
and 19k characters). The next longest was 1,647 characters (a 549-character unit
copied 4 times, itself likely a degeneration). Every other block stayed at or below
about 610 characters. Defaults: `min_chars` 4000 (more than twice the borderline
case, about 6× the legitimate maximum, still early in both observed loops),
`max_period` 1024 (sentence- and paragraph-length loops), `min_repeats` 4. An
output that genuinely asks for more than `min_chars` of exact repetition trips
too; that is the accepted limit.

**Action.** Layer 0 owns the attempt signal, aborted-request billing, the
retry loop and the wall-clock budget, so the guard lives there. On a trip:
abort the attempt (`LLM_DEGENERATE_ABORT_REASON`); bill it once as an aborted
request (estimated usage, the served member's id from the stream's partial
message); keep it health-neutral (the admission wrapper sees `aborted`); re-label
it `environmental` with a `degenerate output` message so the normal pass over the
chain re-issues it (the head's second attempt, then the next member); re-arm the
wall-clock budget, since the attempt spent the clock generating. Bound: 3
re-issues per request, then the error surfaces.

Config: `[models.<name>.repetition_guard]` with optional `min_chars`,
`max_period`, `min_repeats`; an empty table enables the defaults.
