/**
 * App-level refusal handling (ARCHITECTURE.md §8a "Refusals"): a chat session
 * whose request is refused by every chain member parks like a content failure
 * (no doomed retries); a refused head falls over to the chain's next member.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { startHarness, type AppHarness } from "./helpers/app-harness.js";
import type { FakeLlmReply, FakeLlmRequest } from "./helpers/fake-llm.js";

const BACKUP = `
[models.default]
fallback = ["backup"]

[models.backup]
id = "backup-model"
provider = "fake"
api = "openai-completions"
endpoint = "LLM_URL"
api_key = "test-key"
input_modalities = ["text"]
max_tokens = 1024
context_window = 128000
`;

const reply: FakeLlmReply = { toolCalls: [{ name: "send_message", args: { message: "hi", is_reply: false, final: true } }] };

function hasLog(h: AppHarness, message: string, match: Record<string, unknown> = {}): boolean {
  return h.logs.some((l) => l.message === message && Object.entries(match).every(([k, v]) => l[k] === v));
}

function sessionRows(h: AppHarness) {
  return h.query<{ id: string; status: string }>("select id, status from agent_sessions order by created_at, rowid");
}

test("app: a chat request every member refuses parks the session like a content failure, without retries", async () => {
  const h = await startHarness({ script: (_req: FakeLlmRequest) => ({ finishReason: "content_filter" }) });
  try {
    h.say("hello", { mention: true });
    await h.until(() => sessionRows(h).some((r) => r.status === "failed-resumable"), "session parked");
    const [row] = sessionRows(h);
    assert.equal(row!.status, "failed-resumable");
    assert.ok(hasLog(h, "session_parked_failed_resumable", { sessionId: row!.id, class: "refusal" }));
    assert.equal(h.llm.requests.length, 1, "no retry against the refusing member");
    assert.ok(hasLog(h, "llm_refusal", { sessionId: row!.id, rawStopReason: "content_filter", fallover: false }));
    assert.ok(!hasLog(h, "llm_request_attempt_failed"), "not an environmental failure");
    assert.ok(!hasLog(h, "llm_model_unhealthy"), "no health strike");
  } finally {
    await h.stop();
  }
});

test("app: a refused head falls over to the chain's next member and the session completes", async () => {
  const h = await startHarness({
    script: (req: FakeLlmRequest) => (req.body.model === "fake-model" ? { finishReason: "content_filter" } : reply),
    toml: BACKUP,
  });
  try {
    h.say("hello", { mention: true });
    await h.until(() => sessionRows(h).some((r) => r.status === "completed"), "session completed");
    assert.deepEqual(
      h.llm.requests.map((r) => r.body.model),
      ["fake-model", "backup-model"],
      "the refusing head is not retried; the backup serves",
    );
    assert.equal(h.sends.length, 1);
    assert.ok(hasLog(h, "llm_refusal", { model: "fake-model", fallover: true }));
  } finally {
    await h.stop();
  }
});
