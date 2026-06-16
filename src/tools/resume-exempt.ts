import type { AgentTool } from "@earendil-works/pi-agent-core";
import { collectExemptToolNames } from "../agent/work-gate.js";

import { createSendMessageTool } from "./send-message.js";
import { createReactTool } from "./react.js";
import { createEditMessageTool } from "./edit-message.js";
import { createDeleteMessageTool } from "./delete-message.js";
import { createCreatePollTool } from "./create-poll.js";
import { createPollVoteTool } from "./poll-vote.js";
import { createPinsTool } from "./pins.js";
import { createSetProfileTool } from "./set-profile.js";
import { createSpawnSessionTool } from "./spawn-session.js";
import { createDelegateToSessionTool } from "./delegate.js";
import { createMediaTool } from "./media.js";

// =============================================================================
// Context-free built-in resume-work-exempt tool set (spec RESUMABLE-SESSIONS §7a).
//
// The resume work gate consults a set of tool NAMES that do NOT count as work.
// That set is derived from each tool factory's static `resumeWorkExempt` flag —
// the single source of truth (work-gate.ts). The flag is read by constructing a
// tool object, which is why this enumeration must list the *factories* even
// though only the resulting names matter.
//
// CRITICAL: this enumeration is CONTEXT-FREE. It does NOT depend on `roomId`,
// the outbound target, or a per-inbound `buildSessionTools` probe. The earlier
// implementation derived the exempt set from such a probe, which only includes
// the room-scoped exempt tools (`react`, `edit_message`, `delete_message`,
// `pins`, `create_poll`, `poll_vote`) when `target.roomId` is truthy — so a
// (hypothetical) first probe with a falsy roomId would have permanently poisoned
// the memoized cache, silently making pure-chat sessions resumable. Deriving the
// set here, independent of any context, removes that foot-gun entirely.
//
// These eleven factories build a plain tool object and never touch their context
// at construction time (they only dereference it inside `execute`), so a stub
// context is safe — `test/work-gate.test.ts` and `test/resume-exempt.test.ts`
// both rely on exactly this and assert the resulting set equals the spec's list.
// =============================================================================

/**
 * The canonical list of first-party tool factories that carry (or may carry) the
 * `resumeWorkExempt` flag (spec §7a built-in exempt set). Membership in the
 * derived NAME set is still decided by the flag, not this list — a factory listed
 * here without the flag contributes nothing — so the flag stays the source of
 * truth and a stray flag on a work tool cannot sneak in via this enumeration.
 * Adding a new exempt tool requires both flagging its factory AND listing it here;
 * the omission direction is safe (an un-listed exempt tool degrades to "counts as
 * work" → FRESH, the spec's safe failure direction).
 */
const RESUME_EXEMPT_TOOL_FACTORIES: ReadonlyArray<(context: never) => AgentTool> = [
  createSendMessageTool,
  createReactTool,
  createEditMessageTool,
  createDeleteMessageTool,
  createCreatePollTool,
  createPollVoteTool,
  createPinsTool,
  createSetProfileTool,
  createSpawnSessionTool,
  createDelegateToSessionTool,
  createMediaTool,
];

/**
 * The built-in resume-exempt tool NAME set, derived context-free from the static
 * `resumeWorkExempt` flags of {@link RESUME_EXEMPT_TOOL_FACTORIES}. Stable for the
 * process (the flags are compile-time constants), so it is computed once and
 * frozen; callers union their per-context `extra_exempt_tools` on top.
 */
export const BUILTIN_RESUME_EXEMPT_TOOL_NAMES: ReadonlySet<string> = (() => {
  const stub = {} as never;
  const tools = RESUME_EXEMPT_TOOL_FACTORIES.map((factory) => factory(stub));
  return collectExemptToolNames(tools);
})();
