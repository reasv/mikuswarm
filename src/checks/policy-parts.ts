import type { CheckDefinition } from "./types.js";
import type { CheckConsequence } from "./evaluator.js";
import type { GateCallInfo, GateVerdict } from "./gate.js";

/**
 * The revise half of an acting gate policy (spec REFUSAL-HANDLING §6.4). The
 * session's policy composes it with the refusal half: a fired refusal that a
 * rule acts on wins; otherwise this part decides whether revisable checks block
 * the call. Implemented by `createRevisePolicyPart` (`revise.ts`).
 */
export interface RevisePolicyPart {
  /** Hold for revise: a `revise` check took part and the bounds are not exhausted. */
  shouldHold(info: GateCallInfo, checks: readonly CheckDefinition[]): boolean;
  /**
   * Decide on a held verdict with no acting refusal. `block` stops the tool with
   * the error message (consequence `revise`); `pass` lets it proceed, recording
   * `overridden` when the call's override argument skipped fired checks, or
   * `sent` when the bounds let it through.
   */
  decide(info: GateCallInfo, verdict: GateVerdict):
    | { kind: "block"; message: string; consequence: "revise" }
    | { kind: "pass"; consequence?: Extract<CheckConsequence, "overridden" | "sent"> };
  /**
   * Whether {@link decide} would block this verdict now, deciding nothing (the
   * counters do not move): a fired revisable check the call's override does not
   * cover, with no bound exhausted.
   */
  wouldBlock(info: GateCallInfo, verdict: GateVerdict): boolean;
  /** A message was delivered: the consecutive-rejection counter restarts. */
  onDelivered(): void;
}
