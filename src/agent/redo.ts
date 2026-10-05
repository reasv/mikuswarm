/**
 * The runner's redo handler (spec REFUSAL-HANDLING §7.5, §8.4): what
 * `SessionRunner`'s `redo.onRedo` does with a request. Generic over
 * `RedoRequest.kind`:
 *
 * - `contract` (the runner itself, nudges exhausted, `[agent.sessions]
 *   forced_completion_redo`): fork back to the fork point (dropping the failed
 *   attempts and their nudges) and continue on the same model. No model change
 *   is applied here, so whatever selects the session's model (its chain, or a
 *   sticky refusal pin) keeps doing so; the unchanged prefix reads from cache.
 * - `refusal` (the output gate): delegated to `onRefusal`, which picks the rule
 *   entry, pins it and forks through the same fork core. Without one, the
 *   request is logged and the session gives up as it would have.
 */

import type { Agent } from "@earendil-works/pi-agent-core";
import type { Logger } from "../observability/logger.js";
import type { RedoRequest } from "./redo-signal.js";
import type { RedoOutcome } from "./runner.js";
import { findForkPoint, forkSession, type ForkContext } from "./fork.js";
import { servedModelOf } from "./contract.js";
import { isPostingTool } from "../tools/side-effects.js";

/** The refusal redo (`createSoftRefusalRedoHandler`): pin the model, then fork with `forkSession`. */
export type RefusalRedoHandler = (req: RedoRequest, agent: Agent, fork: ForkContext) => Promise<RedoOutcome>;

export interface RedoHandlerOptions {
  fork: ForkContext;
  logger?: Logger;
  onRefusal?: RefusalRedoHandler;
}

/** The logical model that served the last real assistant message, if stamped. */
export function lastServedModel(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown; harness?: unknown } | undefined;
    if (m?.role !== "assistant" || m.harness !== undefined) continue;
    const served = servedModelOf(m);
    if (served) return served;
  }
  return undefined;
}

/** True when a posting tool call delivered (non-error result) in the transcript. */
function hasDelivered(messages: readonly unknown[]): boolean {
  return messages.some((raw) => {
    const m = raw as { role?: unknown; isError?: unknown; toolName?: unknown } | undefined;
    return m?.role === "toolResult" && m.isError !== true && typeof m.toolName === "string" && isPostingTool(m.toolName);
  });
}

export function createRedoHandler(opts: RedoHandlerOptions): (req: RedoRequest, agent: Agent) => Promise<RedoOutcome> {
  const { fork, logger } = opts;
  return async (req, agent) => {
    if (req.kind === "refusal") {
      if (opts.onRefusal) return opts.onRefusal(req, agent, fork);
      logger?.warn("redo_unhandled", { sessionId: fork.sessionId, kind: req.kind, checkCode: req.checkCode });
      return { action: "give_up", noReply: !hasDelivered(agent.state.messages) };
    }
    await agent.waitForIdle();
    const messages = agent.state.messages;
    const model = lastServedModel(messages);
    const point = findForkPoint(messages);
    try {
      const { branchNo } = await forkSession(fork, point, {
        reason: "contract_redo",
        ...(model !== undefined ? { fromModel: model, toModel: model } : {}),
      });
      logger?.info("contract_redo", {
        sessionId: fork.sessionId,
        branchNo,
        forkIndex: point.index,
        model,
      });
      return { action: "continue" };
    } catch (error) {
      logger?.warn("contract_redo_failed", {
        sessionId: fork.sessionId,
        forkIndex: point.index,
        error: error instanceof Error ? error.message : String(error),
      });
      return { action: "give_up", noReply: true };
    }
  };
}
