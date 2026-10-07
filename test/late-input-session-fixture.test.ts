import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

import { SessionManager } from "../src/agent/index.js";
import type { AgentSessionFactory } from "../src/agent/factory.js";
import { createObservabilityServer } from "../src/observability/server/index.js";
import type { Logger } from "../src/observability/index.js";
import { Storage } from "../src/storage/index.js";

// ---------------------------------------------------------------------------
// The console's late-input demo session (ARCHITECTURE.md §8 "Late input", §11)
// is generated here through real storage writes and the real
// `GET /api/sessions/:id` handler, so the branch switcher, cause messages,
// interjection kinds, hold badges and the redo counter parse exactly what the
// agent serves. The test fails when that drifts from the committed fixture;
// regenerate it with
//   UPDATE_LATE_INPUT_SESSION_FIXTURE=1 node --import tsx --test test/late-input-session-fixture.test.ts
// Everything is synthetic (generic model keys, example.org).
// ---------------------------------------------------------------------------

const FIXTURE = new URL("../console/src/lib/server/api/demo/late-input-session.json", import.meta.url);
const SESSION = "ses_li5e2d";
const TIMELINE = "matrix:aria:room:!general:matrix.example.org";
const ADA = { id: "@ada:matrix.example.org", displayName: "Ada" };
const GRACE = { id: "@grace:matrix.example.org", displayName: "Grace" };

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const usage = (input: number, output: number, cost: number) => ({
  input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
function assistant(ts: number, content: unknown[], stopReason = "toolUse", u = usage(6100, 40, 0.0011)): any {
  return {
    role: "assistant", content, api: "openai-completions", provider: "example", model: "vendor/model_a",
    usage: u, stopReason, timestamp: ts, served: { logicalId: "model_a" },
  };
}
function toolResult(ts: number, id: string, name: string, text: string, extra: Record<string, unknown> = {}): any {
  return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: ts, ...extra };
}
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
const kickoff = (ts: number, lines: Array<[string, string]>) => ({
  type: "triggerGroup", role: "user", timestamp: ts,
  content: lines.map(([from, text]) => `<message from="${from}">${text}</message>`).join("\n"),
});
const RECORD_PROMPT = "A later session will see only the chat and this record. Write what it needs to continue this work.";
function recordTurn(ts: number, id: string, text: string): any[] {
  return [
    { role: "user", content: [{ type: "text", text: RECORD_PROMPT }], harness: { kind: "record_turn" }, timestamp: ts },
    assistant(ts + 200, [call(id, "session_record_tool", { action: "create", text })], "toolUse", usage(6900, 50, 0.0012)),
    toolResult(ts + 300, id, "session_record_tool", "Record saved."),
  ];
}

const TRIGGER_6 = "can you post the meetup time in the events room? it's at 6pm";
const TRIGGER_7 = "can you post the meetup time in the events room? it's at 7pm";
const TRIGGER_730 = "can you post the meetup time in the events room? it's at 7:30pm";
const ADDITION = "also tell people to bring snacks!";
const REVIVAL = "is it still at the Elm St hall?";

async function generate(): Promise<unknown> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const event = (id: string, sender: typeof ADA, body: string, ts: number) =>
      storage.appendTimelineEvent(
        { id: `matrix:aria:${id}`, externalId: id, timelineKey: TIMELINE, provider: "matrix", role: "user", sender, body, timestamp: ts, receivedAt: ts } as never,
        "skipped",
      );
    const edit = (id: string, body: string, ts: number) =>
      storage.applyEditToTarget("matrix", id, TIMELINE, { body, attachments: [] }, ts, (e) => ({ ...e, body }), () => "skipped");
    await event("$li-trigger", ADA, TRIGGER_6, 1_000);
    await storage.insertAgentSession({
      id: SESSION, timelineKey: TIMELINE, sessionType: "default", status: "running", modelId: "model_a",
      triggerEventId: "matrix:aria:$li-trigger", triggerExternalId: "$li-trigger", triggerBody: TRIGGER_6,
      triggerSenderId: ADA.id, triggerSenderDisplayName: ADA.displayName, createdAt: 1_000, updatedAt: 1_000,
    });

    // 1. Run 1 holds its first irreversible call; Ada's edit (6pm → 7pm) lands
    //    during the hold, cancels it, and the whole rollout is redone (fork 0).
    await edit("$li-trigger", TRIGGER_7, 2_900);
    await storage.insertSessionBranch({
      sessionId: SESSION, forkIndex: 0, reason: "edit_redo", causeEventId: "matrix:aria:$li-trigger",
      messagesJson: JSON.stringify([
        kickoff(1_000, [["Ada", TRIGGER_6]]),
        assistant(1_600, [call("call-li-1", "send_message", { message: "Meetup tonight at 6pm, see you there!" })]),
        toolResult(3_000, "call-li-1", "send_message", "Not sent: the request was corrected while this call was held.", {
          isError: true, lateInputHold: { heldMs: 1_400, reason: "correction" },
        }),
      ]),
      costUsd: 0.0011, createdAt: 3_000,
    });

    // 2. Run 2 (7pm) looks the venue up; Grace's late addition joins the request
    //    and the rollout is redone from scratch again (fork 0).
    await event("$li-addition", GRACE, ADDITION, 3_700);
    await storage.insertSessionBranch({
      sessionId: SESSION, forkIndex: 0, reason: "addition_redo", causeEventId: "matrix:aria:$li-addition",
      messagesJson: JSON.stringify([
        kickoff(3_000, [["Ada", TRIGGER_7]]),
        assistant(3_400, [call("call-li-2", "search_messages", { query: "meetup venue" })]),
        toolResult(3_600, "call-li-2", "search_messages", "2 messages: the meetup is at the Elm St hall."),
      ]),
      costUsd: 0.0011, createdAt: 4_200,
    });

    // 3. Run 3 (live): the send is held until the hold deadline, then executes.
    //    Ada edits the trigger again (7pm → 7:30pm) while the next turn is being
    //    generated: that turn is aborted and the edit delivered as an interjection.
    const live: any[] = [
      kickoff(4_200, [["Ada", TRIGGER_7], ["Grace", ADDITION]]),
      assistant(4_600, [call("call-li-3", "send_message", { message: "Meetup tonight at 7pm at the Elm St hall, bring snacks!" })]),
      toolResult(8_000, "call-li-3", "send_message", "sent", { lateInputHold: { heldMs: 3_200, reason: "hold_deadline" } }),
    ];
    await edit("$li-trigger", TRIGGER_730, 8_250);
    await storage.insertSessionBranch({
      sessionId: SESSION, forkIndex: 3, reason: "turn_aborted",
      messagesJson: JSON.stringify([
        assistant(8_100, [{ type: "text", text: "Posted! Anything else you" }], "aborted", usage(0, 0, 0)),
      ]),
      createdAt: 8_300,
    });
    const editBody = `Ada edited the message you answered.\nbefore: ${TRIGGER_7}\nafter: ${TRIGGER_730}`;
    live.push(
      { type: "interjection", content: `<interjection reason="edit">\n${editBody}\n</interjection>`, timestamp: 8_300 },
      assistant(8_600, [call("call-li-4", "send_message", { message: "Correction: the meetup is at 7:30pm, not 7pm." })]),
      toolResult(8_700, "call-li-4", "send_message", "sent"),
    );
    await storage.insertSessionInterjection({
      sessionId: SESSION, eventId: "matrix:aria:$li-trigger", externalId: "$li-trigger", senderId: ADA.id,
      senderDisplayName: ADA.displayName, kind: "edit", body: TRIGGER_730, createdAt: 8_300,
    });

    // 4. The run ends and its record turn starts; Grace's question, sent before
    //    the end but delivered after it, revives the session: the record turn is
    //    discarded and the question delivered as a revival interjection.
    await event("$li-revival", GRACE, REVIVAL, 8_900);
    await storage.insertSessionBranch({
      sessionId: SESSION, forkIndex: live.length, reason: "revival", causeEventId: "matrix:aria:$li-revival",
      messagesJson: JSON.stringify(recordTurn(9_000, "call-li-rec-1", "Posted the meetup time (7:30pm, Elm St hall).")),
      costUsd: 0.0012, createdAt: 9_400,
    });
    live.push(
      { type: "interjection", content: `<message from="Grace">${REVIVAL}</message>`, timestamp: 9_400 },
      assistant(9_700, [call("call-li-5", "send_message", { message: "Yes, still the Elm St hall." })]),
      toolResult(9_800, "call-li-5", "send_message", "sent"),
      ...recordTurn(9_900, "call-li-rec-2", "Posted the meetup time (7:30pm, Elm St hall) and answered Grace about the venue."),
    );
    await storage.insertSessionInterjection({
      sessionId: SESSION, eventId: "matrix:aria:$li-revival", externalId: "$li-revival", senderId: GRACE.id,
      senderDisplayName: GRACE.displayName, kind: "revival", body: REVIVAL, createdAt: 9_400,
    });

    await storage.saveAgentSessionTranscript(SESSION, JSON.stringify(live), 10_300);
    await storage.updateAgentSessionStatus(SESSION, "completed", { startedAt: 1_000, completedAt: 10_300, updatedAt: 10_300 });
    await storage.waitForIdle();
    // The runtime counts its redos from scratch; the generator sets the column directly.
    storage.db.prepare(`update agent_sessions set redo_count = 2 where id = ?`).run(SESSION);

    const factory = {
      resolveSessionContextCeiling: () => 128_000,
      resolveSessionCostCeiling: () => undefined,
      toolBlockFor: () => undefined,
    } as unknown as AgentSessionFactory;
    const server = createObservabilityServer({
      config: { enabled: true, bind: "127.0.0.1", port: 0 },
      storage,
      factory,
      sessions: new SessionManager(),
      workspaceRoot: "/tmp",
      logger: silent,
    });
    await server.start();
    try {
      const base = `http://127.0.0.1:${server.address()}`;
      return await (await fetch(`${base}/api/sessions/${SESSION}`)).json();
    } finally {
      await server.stop();
    }
  } finally {
    storage.close();
  }
}

test("console late-input demo session matches what the session API serves", { skip: !existsSync(FIXTURE) && process.env["UPDATE_LATE_INPUT_SESSION_FIXTURE"] !== "1" }, async () => {
  const body = (await generate()) as {
    session: { redoCount: number };
    branches: Array<{ reason: string; forkIndex: number; cause: { body: string; editedAt: number | null } | null }>;
    interjections: Array<{ kind: string }>;
  };
  // The served shape the console reads (ARCHITECTURE.md §11).
  assert.equal(body.session.redoCount, 2);
  assert.deepEqual(body.branches.map((b) => b.reason), ["edit_redo", "addition_redo", "turn_aborted", "revival"]);
  assert.equal(body.branches[0]!.cause?.body, TRIGGER_730, "the cause shows the current (edited) body");
  assert.equal(body.branches[0]!.cause?.editedAt, 8_250);
  assert.equal(body.branches[1]!.cause?.editedAt, null);
  assert.equal(body.branches[2]!.cause, null);
  assert.deepEqual(body.interjections.map((i) => i.kind), ["edit", "revival"]);
  if (process.env["UPDATE_LATE_INPUT_SESSION_FIXTURE"] === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(body, null, "\t")}\n`);
  }
  assert.deepEqual(JSON.parse(readFileSync(FIXTURE, "utf8")), body);
});
