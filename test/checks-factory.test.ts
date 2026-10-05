import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Type } from "@sinclair/typebox";

import { AgentSessionFactory } from "../src/agent/factory.js";
import type { AgentSessionRecord } from "../src/agent/session-manager.js";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { CheckEvaluator } from "../src/checks/evaluator.js";
import type { AppConfig } from "../src/config/index.js";
import type { BuiltContext, ContextBuilder } from "../src/context/index.js";
import { Storage } from "../src/storage/index.js";

// ---------------------------------------------------------------------------
// Factory wiring of the output gate (spec REFUSAL-HANDLING §6): a chat-lane
// session gets `CreatedAgent.gate`, its posting tools pass the gate, and the
// Layer-0 attempt tap starts the evaluation at `toolcall_end`, before execute.
// ---------------------------------------------------------------------------

test("factory: the gate wraps the session's send and starts judging from the attempt tap", async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "m" };
      if (requests === 1) {
        chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Let me answer." }, finish_reason: null }] });
        chunk({
          ...base,
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "send_message", arguments: "{\"message\":\"As an AI, I cannot help.\"}" } }] },
            finish_reason: null,
          }],
        });
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] });
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const config = {
      app: { name: "t", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" },
      agent: { sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 }, system: {} },
      models: {
        default: {
          id: "m", provider: "p", api: "openai-completions", endpoint: `http://127.0.0.1:${port}/v1`,
          api_key: "k", input_modalities: ["text"], max_tokens: 100, context_window: 128_000,
        },
      },
      context: { tiers: { rich_target_tokens: 2000, rich_max_tokens: 4000, compact_target_tokens: 4000, compact_max_tokens: 8000 } },
      storage: { database_path: ":memory:" },
      workspace: { root_dir: "/tmp" },
      matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
      // A pattern-only check: no decision model needed (spec §11).
      checks: { op_ai: { kind: "refusal", reason: "persona", patterns: ["(?i)as an ai\\b"] } },
    } as unknown as AppConfig;
    const built = {
      messages: [
        { type: "system", role: "system", content: "s", tier: "system", tokenEstimate: 1 },
        { type: "triggerGroup", role: "user", content: "hi", tier: "trigger", tokenEstimate: 1, timestamp: 1 },
      ],
      tokenEstimate: 2,
      compactTokens: 0,
      richTokens: 0,
      imageBlocks: [],
    } as unknown as BuiltContext;

    const order: string[] = [];
    const evaluator = new CheckEvaluator({ catalogue: buildCheckCatalogue(config, []), config, storage });
    const start = evaluator.start.bind(evaluator);
    evaluator.start = ((...args: Parameters<typeof start>) => {
      order.push(`start:${args[2].toolCallId}`);
      return start(...args);
    }) as typeof evaluator.start;
    const factory = new AgentSessionFactory({
      config,
      contextBuilder: { build: async () => built } as unknown as ContextBuilder,
      getActiveSessions: () => [],
      outputChecks: { evaluator, chat: () => ({ request: [{ from: "u", text: "hi" }], recent: [] }) },
    });
    const sendTool: any = {
      name: "send_message",
      label: "send",
      description: "Send a message.",
      parameters: Type.Object({ message: Type.String() }),
      execute: async (id: string) => {
        order.push(`execute:${id}`);
        return { content: [{ type: "text", text: "sent" }], details: {}, terminate: true };
      },
    };
    const session = {
      id: "s-factory01", timelineKey: "matrix:a:room:!r", sessionType: "default", status: "running", createdAt: 0,
      trigger: { provider: "matrix", timelineKey: "matrix:a:room:!r", event: { id: "t", timelineKey: "matrix:a:room:!r", provider: "matrix", role: "user", sender: { id: "u" }, body: "hi", timestamp: 1, receivedAt: 1 } },
    } as unknown as AgentSessionRecord;
    const created = await factory.create(session, [sendTool], {});
    assert.ok(created.gate, "a chat-lane session gets a gate");
    await created.agent.prompt(created.kickoff!);
    await created.agent.waitForIdle();
    assert.deepEqual(order, ["start:call_1", "execute:call_1"], "judging starts at toolcall_end, once");
    for (let i = 0; i < 50 && storage.getDecisionEvaluationsForSession("s-factory01").length === 0; i++) {
      await new Promise((r) => setImmediate(r));
    }
    const [row] = storage.getDecisionEvaluationsForSession("s-factory01");
    assert.equal(row?.source, "pattern");
    assert.equal(row?.tool_call_id, "call_1");
    assert.equal(row?.checkpoint, "send");
    const [event] = storage.listRefusalEvents("s-factory01");
    assert.equal(event?.check_code, "op_ai");
    assert.equal(event?.served_model, "default");

    // An internal job build gets no gate.
    const job = await factory.create({ ...session, id: "s-job000001", sessionType: "summarize" } as AgentSessionRecord, [], {
      summarizationCutoff: { endTimestamp: 1 },
    });
    assert.ok(job.agent);
    assert.equal(job.gate, undefined);
  } finally {
    await storage.waitForIdle();
    storage.close();
    server.close();
  }
});
