/**
 * Soft-refusal redo (spec REFUSAL-HANDLING §6.4, §8.4): the runner's handler
 * for a `refusal` redo request the acting gate policy filed. The policy already
 * matched the rule and took its next try (`refusal.advance`, which pins the
 * model); this handler applies it between runs:
 *
 * - **redo**: fork back to the fork point through the fork core (with the
 *   gated call, so a message whose siblings had irreversible effects is kept in
 *   edited form, §8.4 "Sibling tool calls"), re-anchor the discarded span's
 *   decision rows and refusal events to the new branch (§9), and continue on
 *   the pinned model;
 * - **exhausted, `withhold`**: give up and settle as `NO_REPLY` with no notice;
 * - **exhausted, `park`**: park the session like a hard refusal (§8.2).
 *
 * A fork that fails gives up silently (the refused output was never sent).
 */
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { RedoRequest } from "../agent/redo-signal.js";
import type { RedoOutcome } from "../agent/runner.js";
import { findForkPoint, forkFloor, forkSession, type ForkContext, type ForkPoint } from "../agent/fork.js";
import type { RefusalRedoHandler } from "../agent/redo.js";
import type { Logger } from "../observability/logger.js";
import type { Storage } from "../storage/index.js";
import { isPostingTool } from "../tools/side-effects.js";
import type { GatePolicy } from "../checks/gate.js";
import type { ActingGatePolicy } from "../checks/acting-policy.js";

/** The acting-policy extras of a gate's policy, when it is one. */
function acting(policy: GatePolicy | undefined): Partial<Pick<ActingGatePolicy, "blockedRefusals" | "clearBlockedRefusals">> {
  return (policy ?? {}) as Partial<ActingGatePolicy>;
}

export interface SoftRefusalRedoDeps {
  /** Re-anchors the discarded span's statistics; absent = rows stay on branch 0. */
  storage?: Pick<Storage, "reanchorSessionBranch">;
  /**
   * The session's output gate: pending evaluations of discarded calls are
   * re-anchored there, and the acting policy's refused sibling calls are removed
   * together with the gated one.
   */
  gate?: { reanchor(keys: Iterable<string>, branchNo: number): void; policy: GatePolicy };
  logger?: Logger;
}

type Loose = Record<string, unknown>;

function obj(m: unknown): Loose | undefined {
  return m !== null && typeof m === "object" ? (m as Loose) : undefined;
}

function callIds(m: unknown): string[] {
  const content = obj(m)?.["content"];
  if (obj(m)?.["role"] !== "assistant" || !Array.isArray(content)) return [];
  return (content as Loose[])
    .filter((b) => b && b["type"] === "toolCall" && typeof b["id"] === "string")
    .map((b) => b["id"] as string);
}

/** True when a posting call delivered since the current run started (the run's own messages). */
export function deliveredInRun(messages: readonly AgentMessage[]): boolean {
  const results = new Map<string, boolean>();
  for (const raw of messages) {
    const m = obj(raw);
    if (m?.["role"] === "toolResult" && typeof m["toolCallId"] === "string") {
      results.set(m["toolCallId"] as string, m["isError"] === true);
    }
  }
  for (let i = forkFloor(messages); i < messages.length; i += 1) {
    const m = obj(messages[i]);
    if (m?.["role"] !== "assistant" || !Array.isArray(m["content"])) continue;
    for (const block of m["content"] as Loose[]) {
      if (block?.["type"] !== "toolCall" || typeof block["name"] !== "string" || !isPostingTool(block["name"])) continue;
      const isError = results.get(block["id"] as string);
      if (isError === false) return true;
    }
  }
  return false;
}

/** The latest message timestamp in `messages` (requests issued after it belong to a discarded span). */
function lastTimestamp(messages: readonly AgentMessage[]): number | undefined {
  let latest: number | undefined;
  for (const raw of messages) {
    const ts = obj(raw)?.["timestamp"];
    if (typeof ts === "number" && Number.isFinite(ts) && (latest === undefined || ts > latest)) latest = ts;
  }
  return latest;
}

/** The runner's `onRefusal` (W2's {@link RefusalRedoHandler}) for soft refusals. */
export function createSoftRefusalRedoHandler(deps: SoftRefusalRedoDeps = {}): RefusalRedoHandler {
  const { logger } = deps;
  return async (req: RedoRequest, agent: Agent, fork: ForkContext): Promise<RedoOutcome> => {
    await agent.waitForIdle();
    const messages = agent.state.messages;
    const base = {
      sessionId: fork.sessionId,
      checkCode: req.checkCode,
      reason: req.reason,
      rule: req.ruleName,
      fromModel: req.refusedModel,
      toolCallId: req.toolCallId,
    };
    if (req.exhausted === "withhold" || (req.exhausted === undefined && req.toModel === undefined)) {
      acting(deps.gate?.policy).clearBlockedRefusals?.();
      logger?.info("soft_refusal_withheld", base);
      return { action: "give_up", noReply: !deliveredInRun(messages) };
    }
    if (req.exhausted === "park") {
      acting(deps.gate?.policy).clearBlockedRefusals?.();
      logger?.info("soft_refusal_parked", base);
      return {
        action: "park",
        message: `soft refusal (${req.checkCode ?? "refusal"}) and every entry of rule "${req.ruleName ?? "?"}" refused`,
      };
    }

    let point: ForkPoint = findForkPoint(messages, req.toolCallId ? { gatedToolCallId: req.toolCallId } : {});
    // Other calls of the same message refused too: they leave with the gated one.
    const blocked = acting(deps.gate?.policy).blockedRefusals?.();
    if (point.siblingEdit && blocked && blocked.size > 0) {
      const inMessage = new Set(callIds(messages[point.siblingEdit.messageIndex]));
      const remove = new Set(point.siblingEdit.removeToolCallIds);
      for (const id of blocked) if (inMessage.has(id)) remove.add(id);
      point = { ...point, siblingEdit: { ...point.siblingEdit, removeToolCallIds: [...remove] } };
    }
    const kept = messages.slice(0, point.index);
    const keptCallIds = new Set(kept.flatMap(callIds));
    if (point.siblingEdit) {
      const remove = new Set(point.siblingEdit.removeToolCallIds);
      for (const id of callIds(messages[point.siblingEdit.messageIndex])) if (!remove.has(id)) keptCallIds.add(id);
    }
    const discardedCallIds = messages
      .slice(point.index)
      .flatMap(callIds)
      .filter((id) => !keptCallIds.has(id));
    // Hard refusals of requests issued inside the discarded span (a sibling edit
    // keeps the request that wrote the edited message, so none move then).
    const sinceTs = point.siblingEdit ? undefined : lastTimestamp(kept);

    let branchNo: number;
    try {
      ({ branchNo } = await forkSession(fork, point, {
        reason: "refusal_redo",
        ...(req.checkCode ? { checkCode: req.checkCode } : {}),
        ...(req.decisionEvaluationId !== undefined ? { decisionEvaluationId: req.decisionEvaluationId } : {}),
        ...(req.refusedModel ? { fromModel: req.refusedModel } : {}),
        ...(req.toModel ? { toModel: req.toModel } : {}),
      }));
    } catch (error) {
      acting(deps.gate?.policy).clearBlockedRefusals?.();
      logger?.warn("soft_refusal_redo_failed", {
        ...base,
        forkIndex: point.index,
        error: error instanceof Error ? error.message : String(error),
      });
      return { action: "give_up", noReply: !deliveredInRun(agent.state.messages) };
    }
    acting(deps.gate?.policy).clearBlockedRefusals?.();
    deps.gate?.reanchor(discardedCallIds, branchNo);
    if (deps.storage) {
      try {
        await deps.storage.reanchorSessionBranch(fork.sessionId, {
          branchNo,
          toolCallIds: discardedCallIds,
          ...(req.evaluationIds ? { evaluationIds: req.evaluationIds } : {}),
          ...(sinceTs !== undefined ? { sinceTs } : {}),
        });
      } catch (error) {
        logger?.warn("refusal_branch_reanchor_failed", {
          sessionId: fork.sessionId,
          branchNo,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger?.info("soft_refusal_redo", {
      ...base,
      toModel: req.toModel,
      branchNo,
      forkIndex: point.index,
      siblingEdit: point.siblingEdit !== undefined,
    });
    return { action: "continue" };
  };
}
