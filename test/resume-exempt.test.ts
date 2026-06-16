import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_RESUME_EXEMPT_TOOL_NAMES } from "../src/tools/resume-exempt.ts";

// Review issue #6: the resume work gate's built-in exempt set must be derived
// CONTEXT-FREE (independent of roomId / outbound target / any per-inbound
// `buildSessionTools` probe). The earlier implementation read the set from such a
// probe, and six of the exempt tools (`react`, `edit_message`, `delete_message`,
// `pins`, `create_poll`, `poll_vote`) are only included when `target.roomId` is
// truthy — so a first probe with a falsy roomId would have permanently poisoned
// the memoized cache, silently making pure-chat sessions resumable. These tests
// lock in the context-free derivation and that all eleven names (including the six
// room-scoped ones) are present without any context.

// The spec §7a built-in exempt set, verbatim.
const SPEC_EXEMPT = [
  "create_poll",
  "delegate_to_session",
  "delete_message",
  "edit_message",
  "media",
  "pins",
  "poll_vote",
  "react",
  "send_message",
  "set_profile",
  "spawn_session",
] as const;

// The six tools that `buildSessionTools` only wires when `target.roomId` is truthy
// — the exact ones a falsy-roomId probe would have dropped (issue #6 root cause).
const ROOM_SCOPED_EXEMPT = ["react", "edit_message", "delete_message", "pins", "create_poll", "poll_vote"] as const;

test("issue #6: built-in resume-exempt set equals exactly the 11 spec tools", () => {
  assert.deepEqual([...BUILTIN_RESUME_EXEMPT_TOOL_NAMES].sort(), [...SPEC_EXEMPT].sort());
  assert.equal(BUILTIN_RESUME_EXEMPT_TOOL_NAMES.size, 11);
});

test("issue #6: the room-scoped exempt tools are present WITHOUT any roomId/target context", () => {
  // The set is built from a context-free enumeration of the tool factories' static
  // `resumeWorkExempt` flags — no `target`, no `roomId`, no probe — so the
  // room-scoped six can never silently drop out the way a falsy-roomId probe
  // allowed. This is the regression guard for the memoized-cache foot-gun.
  for (const name of ROOM_SCOPED_EXEMPT) {
    assert.ok(
      BUILTIN_RESUME_EXEMPT_TOOL_NAMES.has(name),
      `${name} must be in the context-free built-in exempt set`,
    );
  }
});

test("issue #6: the built-in set is stable across reads (no first-probe poisoning)", () => {
  // A module-level constant computed once; repeated reads return the same eleven
  // names regardless of access order. (Contrast the old lazily-memoized probe,
  // whose result depended on the FIRST caller's context.)
  const first = [...BUILTIN_RESUME_EXEMPT_TOOL_NAMES].sort();
  const second = [...BUILTIN_RESUME_EXEMPT_TOOL_NAMES].sort();
  assert.deepEqual(first, second);
  assert.deepEqual(first, [...SPEC_EXEMPT].sort());
});
