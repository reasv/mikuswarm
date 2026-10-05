/**
 * Per-session wiring of the output gate (spec REFUSAL-HANDLING §6): the
 * factory builds one {@link OutputGate} per chat-lane session (fresh, resumed
 * and proactive alike) from the app's shared services, wraps the session's
 * gated tools with it, and taps the live attempt stream for the early start.
 * Kept here so the factory change stays a few call-site hooks.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AgentSessionRecord } from "../agent/session-manager.js";
import type { Logger } from "../observability/logger.js";
import type { CheckEvaluator } from "./evaluator.js";
import { OutputGate, type GatePolicy } from "./gate.js";
import type { StateMessage } from "./state.js";

/** What the app hands the factory (built once in app.ts, CONTRACT R2). */
export interface OutputGateServices {
  evaluator: CheckEvaluator;
  /**
   * The session's request (trigger or kickoff) and the latest `recentMessages`
   * chat messages, as check state (spec §5.5). Read when an evaluation starts.
   */
  chat?: (session: AgentSessionRecord, recentMessages: number) => { request: StateMessage[]; recent: StateMessage[] };
  /** The policy of new gates; default observe-only (phase 3). */
  policy?: (session: AgentSessionRecord) => GatePolicy | undefined;
  logger?: Logger;
}

/**
 * The gate of one session, or undefined when the app wired no checks or the
 * session is an internal job build (summaries, diary: judged by
 * BackgroundChecks at their artifact/rollout instead).
 */
export function createSessionOutputGate(
  services: OutputGateServices | undefined,
  args: {
    session: AgentSessionRecord;
    agentName: string | null;
    triggerSenderId: string | null;
    internalJob: boolean;
    getMessages: () => readonly AgentMessage[];
    servingModel: () => string | undefined;
  },
): OutputGate | undefined {
  if (!services || args.internalJob) return undefined;
  const { session } = args;
  const policy = services.policy?.(session);
  return new OutputGate({
    evaluator: services.evaluator,
    scope: {
      agent: args.agentName,
      site: session.sessionType,
      sessionId: session.id,
      sessionType: session.sessionType,
      timelineKey: session.timelineKey,
      triggerSenderId: args.triggerSenderId,
      tasks: null,
    },
    getMessages: args.getMessages,
    ...(services.chat ? { chat: (recent: number) => services.chat!(session, recent) } : {}),
    servingModel: args.servingModel,
    ...(policy ? { policy } : {}),
    ...(services.logger ? { logger: services.logger } : {}),
  });
}

type AttemptTap = {
  onAttemptEvent?: (attempt: number, event: AssistantMessageEvent) => void;
  onAttemptDiscarded?: (attempt: number, reason: string) => void;
};

/**
 * Add the gate to Layer 0's observe-only attempt tap (`onAttemptEvent` /
 * `onAttemptDiscarded`, ARCHITECTURE.md §8a) beside whatever else listens.
 */
export function withGateTap<T extends AttemptTap>(tap: T, gate: OutputGate | undefined): T | (T & Required<AttemptTap>) {
  if (!gate) return tap;
  return {
    ...tap,
    onAttemptEvent: (attempt: number, event: AssistantMessageEvent) => {
      try {
        gate.onAttemptEvent(attempt, event);
      } catch {
        /* observe-only: the tap can never affect the run */
      }
      tap.onAttemptEvent?.(attempt, event);
    },
    onAttemptDiscarded: (attempt: number, reason: string) => {
      try {
        gate.onAttemptDiscarded(attempt);
      } catch {
        /* observe-only */
      }
      tap.onAttemptDiscarded?.(attempt, reason);
    },
  };
}
