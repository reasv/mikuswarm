/**
 * Synthetic raw rows for the model behaviour tests (spec REFUSAL-HANDLING §12.3):
 * two chat sessions in one hour plus sessionless caption rows. No chat content.
 */
import type { Storage } from "../src/storage/index.js";

export const HOUR = 3_600_000;
export const H = 1_000 * HOUR; // an hour-aligned base time

/** "matrix:acc_a:…" → agent_a, "matrix:acc_b:…" → agent_b. */
export function agentFor(key: string | null): string | null {
  if (!key) return null;
  if (key.startsWith("matrix:acc_a:")) return "agent_a";
  if (key.startsWith("matrix:acc_b:")) return "agent_b";
  return null;
}

export const KEY_A = "matrix:acc_a:room:!r1:x";
export const KEY_B = "matrix:acc_b:room:!r2:x";

export async function addSession(
  storage: Storage,
  id: string,
  opts: { key: string; type: string; createdAt: number; tasks?: string[] },
): Promise<void> {
  await storage.insertAgentSession({
    id, timelineKey: opts.key, sessionType: opts.type, status: "completed", createdAt: opts.createdAt, updatedAt: opts.createdAt,
  });
  if (opts.tasks) await storage.setSessionInitialPreloads(id, { skills: [], tasks: opts.tasks } as never);
}

export async function addRequest(storage: Storage, sessionId: string | null, ts: number, model: string, opts: { key?: string; type?: string; cls?: "agent_loop" | "caption" } = {}): Promise<void> {
  await storage.insertUsageEvent({
    ts,
    class: opts.cls ?? "agent_loop",
    agentSessionId: sessionId,
    sessionType: opts.type ?? null,
    timelineKey: opts.key ?? null,
    modelId: `wire-${model}`,
    logicalModelId: model,
    costUsd: 0.01,
  });
}

export async function addMessage(storage: Storage, sessionId: string, id: string, receivedAt: number, body: string, key = KEY_A): Promise<void> {
  await storage.write((db) =>
    db
      .prepare(
        `insert into timeline_events (id, timeline_key, provider, role, sender_id, body, timestamp, received_at,
           agent_session_id, event_json, enrichment_status, created_at, updated_at)
         values (?, ?, 'matrix', 'assistant', '@bot:x', ?, ?, ?, ?, '{}', 'skipped', ?, ?)`,
      )
      .run(id, key, body, receivedAt, receivedAt, sessionId, receivedAt, receivedAt),
  );
}

/** Two sessions in hour H (agent_a default with a task, agent_b proactive) + sessionless caption rows. */
export async function seedScenario(storage: Storage): Promise<void> {
  // s1: agent_a, default, task coding. model_a refuses (hard, distillation), a rule
  // redoes it on model_b; model_b then needs one nudge and recovers; a style check
  // fires on one call (two decision rows + a pattern row share the anchor) and the
  // agent revises; two messages sent (one split in two chunks).
  await addSession(storage, "s1", { key: KEY_A, type: "default", createdAt: H + 1_000, tasks: ["coding"] });
  await addRequest(storage, "s1", H + 2_000, "model_a", { key: KEY_A, type: "default" });
  await storage.insertRefusalEvent({
    ts: H + 2_500, agentSessionId: "s1", site: "default", agent: "agent_a", timelineKey: KEY_A, tasks: ["coding"],
    servedModel: "model_a", kind: "hard", checkCode: "refusal_distillation", reason: "distillation",
    method: "provider_category", checkpoint: "request", outcome: "redo", toModel: "model_b", ruleName: "distill",
  });
  await addRequest(storage, "s1", H + 5_000, "model_b", { key: KEY_A, type: "default" });
  const verdict = JSON.stringify({ fired: [{ code: "style_x", kind: "style" }] });
  for (const source of ["model", "model", "pattern"] as const) {
    await storage.insertDecisionEvaluation({
      ts: H + 5_500, decision_group: "g1", point: "checks", agent_session_id: "s1", source,
      verdict_json: verdict, checkpoint: "send", branch_no: 0, tool_call_id: "tc1", consequence: "revise",
    });
  }
  await storage.insertContractAttempts([
    { agentSessionId: "s1", attemptNo: 0, ts: H + 6_000, servedModel: "model_b", variant: "original", failureTypes: ["text_only"], primaryType: "text_only" },
    { agentSessionId: "s1", attemptNo: 1, ts: H + 6_500, servedModel: "model_b", variant: "not_sent", failureTypes: [] },
  ]);
  await storage.setAgentSessionContract("s1", { outcome: "recovered", nudges: 1, version: 1 });
  await addMessage(storage, "s1", "assistant:s1:e1:0", H + 7_000, "hello there friend");
  await addMessage(storage, "s1", "assistant:s1:e1:1", H + 7_001, "and more");
  await addMessage(storage, "s1", "assistant:s1:e2:0", H + 8_000, "second message");
  await storage.insertSessionBranch({
    sessionId: "s1", forkIndex: 2, reason: "refusal_redo", checkCode: "refusal_distillation",
    fromModel: "model_a", toModel: "model_b", messagesJson: "[]", costUsd: 0.05, createdAt: H + 2_600,
  });

  // s2: agent_b, proactive, model_a only: three nudges, a contract redo, exhausted.
  await addSession(storage, "s2", { key: KEY_B, type: "proactive", createdAt: H + 3_000 });
  await addRequest(storage, "s2", H + 3_500, "model_a", { key: KEY_B, type: "proactive" });
  await storage.insertContractAttempts(
    [0, 1, 2, 3].map((n) => ({
      agentSessionId: "s2", attemptNo: n, ts: H + 4_000 + n, servedModel: "model_a",
      variant: n === 0 ? "original" : "not_sent", failureTypes: ["empty"], primaryType: "empty",
    })),
  );
  await storage.setAgentSessionContract("s2", { outcome: "exhausted", nudges: 3, version: 1 });
  await storage.insertSessionBranch({
    sessionId: "s2", forkIndex: 1, reason: "contract_redo", fromModel: "model_a", toModel: "model_a",
    messagesJson: "[]", costUsd: 0.02, createdAt: H + 4_100,
  });

  // Sessionless: a caption request and a caption refusal on cap_model.
  await addRequest(storage, null, H + 100, "cap_model", { key: KEY_A, cls: "caption" });
  await storage.insertRefusalEvent({
    ts: H + 150, site: "caption", timelineKey: KEY_A, servedModel: "cap_model", kind: "hard",
    checkCode: "refusal_safety", reason: "safety", method: "stop_reason", checkpoint: "request", outcome: "exhausted_no_output",
  });
}
