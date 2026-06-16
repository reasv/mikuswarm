import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";

// =============================================================================
// Resume work gate (spec RESUMABLE-SESSIONS §7a).
//
// Resume exists to continue STATEFUL work, not conversation. A session whose
// rollout is pure chat (only chat-surface tools) holds nothing a fresh session
// lacks — the chat history already carries it — so resuming it is pure cost
// (dragging the prior rollout back, re-injecting a fresh satellite each time).
// The work gate forbids this. It is ALWAYS on (≥1 non-exempt tool call required);
// only the two knobs below are configurable per context.
// =============================================================================

declare module "@earendil-works/pi-agent-core" {
  // Declaration-merge an optional classification flag onto EVERY tool definition
  // (spec §7a "a flag on the AgentTool definition rather than a hidden central
  // list, so a new tool is forced to declare its bucket and can't silently
  // drift"). The flag is the single source of truth; the gate derives its exempt
  // NAME set from the live tools via {@link collectExemptToolNames}. Named for
  // its meaning (exempt from the resume WORK gate) rather than the spec's
  // `chatSurface` example, because two of the exempt tools — the `spawn_session`/
  // `delegate_to_session` control tools and `media` — are not chat-surface tools;
  // they share only their non-work status.
  interface AgentTool {
    /**
     * When true, this tool does NOT count as resumable work (spec §7a): its
     * entire effect is already visible on the chat surface, OR it is pure control
     * flow, OR (the `media` case) its result is regenerable from the chat. A
     * rollout containing ONLY exempt tool calls has no continuable rollout state
     * a fresh session lacks, so a reply to it degrades to a fresh session. Unset
     * = counts as work (the large default bucket). Lean exempt for anything
     * ambiguous — the safe failure direction is "didn't resume".
     */
    resumeWorkExempt?: boolean;
  }
}

export type ResumeWorkScope = "since_last_turn" | "any_in_history";

/**
 * The exempt tool-NAME set the work gate consults (a persisted transcript carries
 * only tool names). Built from the live tool set's {@link AgentTool.resumeWorkExempt}
 * flags plus the per-context `extra_exempt_tools` config list (which must accept
 * `mcp__…` names — they appear verbatim in the transcript, so adding them here is
 * sufficient). `test/work-gate.test.ts` asserts the flagged built-in set matches
 * the spec's enumerated exempt list, so a mis-flagged tool fails fast.
 */
export function collectExemptToolNames(
  tools: readonly AgentTool[],
  extra: readonly string[] = [],
): Set<string> {
  const set = new Set<string>(extra);
  for (const tool of tools) {
    if (tool.resumeWorkExempt === true) set.add(tool.name);
  }
  return set;
}

/**
 * Does this transcript contain ≥1 NON-exempt tool call within the configured
 * scope (spec §7a base rule)? Thinking / text / content blocks never count — only
 * `toolCall` blocks in assistant turns, classified by name against `exemptToolNames`.
 *
 * - `any_in_history` (loose): a non-exempt call ANYWHERE in the transcript. Keeps a
 *   thread resumable as long as it ever did work (research carried through a chain
 *   of follow-up questions). Default in DMs.
 * - `since_last_turn` (strict): a non-exempt call only in the segment since the
 *   LAST real user turn — equivalently, the latest resume-generation's rollout.
 *   Each generation starts with exactly one real user turn (a `triggerGroup`/
 *   `satellite` message); interjections are messages WITHIN a segment, never
 *   boundaries, so work triggered by an interjection counts toward its segment.
 *   Forces each turn to itself keep doing work — a work session whose latest turn
 *   produced only conversation stops being resumable. Default in groups.
 */
export function hasResumableWork(
  transcript: readonly AgentMessage[],
  opts: { scope: ResumeWorkScope; exemptToolNames: ReadonlySet<string> },
): boolean {
  let startIndex = 0;
  if (opts.scope === "since_last_turn") {
    // The latest real user turn delimits the latest generation's rollout. Only
    // true triggers / resume-triggers (typed triggerGroup/satellite) delimit
    // segments — NOT interjections.
    //
    // The "no boundary found → scan all (startIndex stays 0)" case is purely
    // DEFENSIVE: it cannot occur for a reply-resumable session, because every such
    // transcript carries ≥1 triggerGroup/satellite boundary (each resume generation
    // begins with exactly one real user turn, §6). So in practice the loop below
    // always finds a boundary. Note that for THIS gate "scan the whole transcript"
    // is the LESS safe direction, not the more conservative one: a wider scan is
    // *more* likely to find a non-exempt call → more likely to RESUME, and the spec's
    // safe failure direction is the opposite ("didn't resume" → degrade to a fresh
    // session, §7a). The no-boundary fallback is therefore tolerated only because it
    // is unreachable for real input; if a malformed transcript ever lacked a boundary
    // it would scan-all and lean toward resuming — acceptable solely because it can't
    // happen, NOT because scanning all is itself the conservative choice.
    for (let i = transcript.length - 1; i >= 0; i--) {
      const type = (transcript[i] as { type?: string }).type;
      if (type === "triggerGroup" || type === "satellite") {
        startIndex = i;
        break;
      }
    }
  }
  for (let i = startIndex; i < transcript.length; i++) {
    const msg = transcript[i] as { role?: string; content?: unknown };
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const call = block as { type?: string; name?: unknown };
      if (call?.type === "toolCall" && typeof call.name === "string") {
        if (!opts.exemptToolNames.has(call.name)) return true;
      }
    }
  }
  return false;
}
