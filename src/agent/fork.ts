/**
 * Fork core (spec REFUSAL-HANDLING §8.4, §9): discard the live transcript back
 * to a fork point, keep the discarded span as a branch, and leave the agent
 * ready to continue. Used by every redo that discards output: a refusal caught
 * at the gate (W4), a refusal at an ending without a send, and the send-contract
 * redo after the nudges run out (§7.5).
 *
 * A tool cannot rewind the agent loop from inside it, so forks only happen
 * between runs: the runner calls {@link forkSession} after the run settled (it
 * waits for the agent to be idle, which includes sibling tool calls still
 * executing in the same assistant message).
 */

import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Storage } from "../storage/index.js";
import type { Logger } from "../observability/logger.js";
import type { SessionLiveEventBus } from "../observability/live-events.js";
import { isPostingTool, toolEffect } from "../tools/side-effects.js";
import { serializeForPersistence } from "./session-capture.js";
import { isRunStart } from "./contract.js";

/**
 * Where to fork. The live list keeps `messages[0:index]`; the rest is the
 * discarded span. With `siblingEdit`, `messages[index]` (the assistant message
 * holding the gated call) is kept in edited form: the listed calls and their
 * results removed, the other calls kept with their results, its text and
 * thinking dropped.
 */
export interface ForkPoint {
  index: number;
  siblingEdit?: { messageIndex: number; removeToolCallIds: string[] };
}

export interface ForkMeta {
  reason: "refusal_redo" | "contract_redo";
  checkCode?: string;
  decisionEvaluationId?: number;
  fromModel?: string;
  toModel?: string;
}

/** What a fork changed, for the factory's re-derivation of append-only state. */
export interface ForkChange {
  forkIndex: number;
  /** The original messages from `forkIndex` on (the stored span). */
  discarded: readonly AgentMessage[];
  /** The new live list. */
  kept: readonly AgentMessage[];
}

/**
 * Everything a fork needs from the session, built by the factory
 * (`CreatedAgent.forkContext(deps)`), which owns the state derived from the
 * append-only transcript and resets it in `onForked`.
 */
export interface ForkContext {
  readonly sessionId: string;
  readonly agent: Agent;
  readonly storage: Pick<Storage, "insertSessionBranch">;
  /** Persist the live transcript now (the session capture's `flushNow`). */
  flushTranscript(): Promise<void>;
  /**
   * Called after the live list changed: re-derive state that assumed the
   * transcript only grows (running context counter, loaded dynamic tools).
   */
  onForked?(change: ForkChange): void;
  readonly liveEvents?: SessionLiveEventBus;
  readonly logger?: Logger;
}

type Loose = Record<string, unknown>;

function obj(m: unknown): Loose | undefined {
  return m !== null && typeof m === "object" ? (m as Loose) : undefined;
}

function toolCalls(m: Loose): { id: string; name: string; args: unknown }[] {
  if (!Array.isArray(m["content"])) return [];
  return (m["content"] as Loose[])
    .filter((b) => b && b["type"] === "toolCall" && typeof b["name"] === "string")
    .map((b) => ({ id: typeof b["id"] === "string" ? (b["id"] as string) : "", name: b["name"] as string, args: b["arguments"] }));
}

/**
 * The first index a fork may cut at: just after the current run's start turn
 * (the last run-start message) and the harness messages that directly follow
 * it (synthetic injections). Everything before belongs to earlier runs or is
 * the run's own kickoff, which the redo keeps.
 */
export function forkFloor(messages: readonly AgentMessage[]): number {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isRunStart(messages[i])) {
      start = i;
      break;
    }
  }
  let floor = start + 1;
  while (floor < messages.length && obj(messages[floor])?.["harness"] !== undefined) floor += 1;
  return floor;
}

/**
 * The fork point of a redo (spec §8.4, owner decisions 2 and 23): the later of
 * the last delivered message and the last irreversible tool effect, never
 * before {@link forkFloor}. A posting call counts once its result is not an
 * error (delivered); any other irreversible call counts once it ran (has a
 * result) or when its result is missing (conservative). The fork lands after
 * the effect's whole tool-result group.
 *
 * With `gatedToolCallId` (a refusal at a send), only messages before the gated
 * call's assistant message count; when that message has another call with an
 * irreversible effect, the fork point is the message itself with a sibling
 * edit removing the gated call. When every sibling is redo-safe the whole
 * message is discarded and redone.
 */
export function findForkPoint(
  messages: readonly AgentMessage[],
  opts: { gatedToolCallId?: string } = {},
): ForkPoint {
  const results = new Map<string, { index: number; isError: boolean }>();
  messages.forEach((raw, index) => {
    const m = obj(raw);
    if (m?.["role"] === "toolResult" && typeof m["toolCallId"] === "string") {
      results.set(m["toolCallId"] as string, { index, isError: m["isError"] === true });
    }
  });
  const hasEffect = (call: { id: string; name: string; args: unknown }): boolean => {
    if (toolEffect(call.name, call.args) !== "irreversible") return false;
    const result = results.get(call.id);
    if (isPostingTool(call.name)) return result === undefined || !result.isError;
    return true;
  };

  let gatedIndex: number | undefined;
  if (opts.gatedToolCallId !== undefined) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = obj(messages[i]);
      if (m?.["role"] === "assistant" && toolCalls(m).some((c) => c.id === opts.gatedToolCallId)) {
        gatedIndex = i;
        break;
      }
    }
  }

  const floor = forkFloor(messages);
  let index = floor;
  const limit = gatedIndex ?? messages.length;
  for (let i = floor; i < limit; i += 1) {
    const m = obj(messages[i]);
    if (m?.["role"] !== "assistant") continue;
    const calls = toolCalls(m);
    if (!calls.some(hasEffect)) continue;
    let end = i;
    for (const call of calls) {
      const r = results.get(call.id);
      if (r && r.index > end) end = r.index;
    }
    index = Math.max(index, end + 1);
  }

  if (gatedIndex !== undefined && gatedIndex >= index) {
    const siblings = toolCalls(obj(messages[gatedIndex])!).filter((c) => c.id !== opts.gatedToolCallId);
    if (siblings.some(hasEffect)) {
      return { index: gatedIndex, siblingEdit: { messageIndex: gatedIndex, removeToolCallIds: [opts.gatedToolCallId!] } };
    }
  }
  return { index };
}

/** Summed provider cost of the assistant messages in a span. */
function spanCost(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const raw of messages) {
    const m = obj(raw);
    if (m?.["role"] !== "assistant") continue;
    const cost = obj(obj(m["usage"])?.["cost"])?.["total"];
    if (typeof cost === "number" && Number.isFinite(cost)) total += cost;
  }
  return total;
}

/**
 * Fork the session at `point` (spec §8.4, §9):
 *
 * 1. waits for the agent to be idle (in-flight sibling tool calls settle into
 *    the message they belong to);
 * 2. stores the discarded span `messages[index:]` (sanitized like transcripts)
 *    as a new branch row and gets its number;
 * 3. replaces the live list: the prefix, the edited message and its kept
 *    sibling results for a sibling edit, then every interjection delivered
 *    inside the span, redelivered (the same message objects, so the app's
 *    unread-steer bookkeeping still sees them as read);
 * 4. lets the factory re-derive append-only state (`onForked`), flushes the
 *    transcript, emits `branch_forked` on the live bus and logs `session_forked`.
 *
 * Throws when the fork point leaves nothing to discard or is out of range;
 * nothing is changed then.
 */
export async function forkSession(ctx: ForkContext, point: ForkPoint, meta: ForkMeta): Promise<{ branchNo: number }> {
  const { agent } = ctx;
  await agent.waitForIdle();
  const messages = agent.state.messages.slice();
  const index = point.index;
  if (!Number.isInteger(index) || index < 0 || index >= messages.length) {
    throw new Error(`fork point ${index} leaves nothing to discard (${messages.length} messages)`);
  }
  const discarded = messages.slice(index);

  const kept: AgentMessage[] = messages.slice(0, index);
  let costSpan: readonly AgentMessage[] = discarded;
  const edit = point.siblingEdit;
  if (edit) {
    if (edit.messageIndex !== index) throw new Error("sibling edit must be at the fork index");
    const original = obj(messages[index]);
    if (original?.["role"] !== "assistant" || !Array.isArray(original["content"])) {
      throw new Error("sibling edit target is not an assistant message");
    }
    const remove = new Set(edit.removeToolCallIds);
    const content = (original["content"] as Loose[]).filter(
      (b) => b && b["type"] === "toolCall" && !remove.has(b["id"] as string),
    );
    const keptIds = new Set(content.map((b) => b["id"] as string));
    kept.push({ ...(original as object), content } as unknown as AgentMessage);
    for (const raw of discarded.slice(1)) {
      const m = obj(raw);
      if (m?.["role"] === "toolResult" && keptIds.has(m["toolCallId"] as string)) kept.push(raw);
    }
    // The original request's spend stays with the live (edited) message.
    costSpan = discarded.slice(1);
  }
  const redelivered = discarded.filter((m) => obj(m)?.["type"] === "interjection" && !kept.includes(m));
  kept.push(...redelivered);

  const branchNo = await ctx.storage.insertSessionBranch({
    sessionId: ctx.sessionId,
    parentBranchNo: 0,
    forkIndex: index,
    reason: meta.reason,
    checkCode: meta.checkCode ?? null,
    decisionEvaluationId: meta.decisionEvaluationId ?? null,
    fromModel: meta.fromModel ?? null,
    toModel: meta.toModel ?? null,
    messagesJson: serializeForPersistence(discarded),
    costUsd: spanCost(costSpan),
  });

  agent.state.messages = kept;
  (agent.state as { errorMessage?: string }).errorMessage = undefined;
  try {
    ctx.onForked?.({ forkIndex: index, discarded, kept });
  } catch (error) {
    ctx.logger?.warn("session_fork_rederive_failed", {
      sessionId: ctx.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await ctx.flushTranscript();
  ctx.liveEvents?.publish(ctx.sessionId, {
    type: "branch_forked",
    branchNo,
    forkIndex: index,
    reason: meta.reason,
    ...(meta.checkCode !== undefined ? { checkCode: meta.checkCode } : {}),
    ...(meta.fromModel !== undefined ? { fromModel: meta.fromModel } : {}),
    ...(meta.toModel !== undefined ? { toModel: meta.toModel } : {}),
  });
  ctx.logger?.info("session_forked", {
    sessionId: ctx.sessionId,
    branchNo,
    forkIndex: index,
    reason: meta.reason,
    checkCode: meta.checkCode,
    fromModel: meta.fromModel,
    toModel: meta.toModel,
    discarded: discarded.length,
    siblingEdit: edit !== undefined,
    redeliveredInterjections: redelivered.length,
  });
  return { branchNo };
}
