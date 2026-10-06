/**
 * read_session_record / read_session_transcript (spec SESSION-RECORDS §5) and
 * the record-turn gate (CONTRACT §3), asserted through pi-agent-core's real
 * tool-execution path: an error is only an error on the wire when pi marks the
 * toolResult `isError`, which happens only when `execute` throws.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Storage } from "../src/storage/index.js";
import { ChannelVisibilityResolver } from "../src/visibility/index.js";
import {
  createReadSessionRecordTool,
  createReadSessionTranscriptTool,
  type ReadSessionRecordToolContext,
} from "../src/tools/read-session-record.js";
import { createSessionRecordTool, SummaryDraft } from "../src/tools/session-record-tool.js";
import { wrapToolsWithRecordTurnGate } from "../src/agent/record-turn.js";
import { executeSyntheticCalls } from "../src/agent/synthetic-calls.js";
import { DynamicToolRegistry, wrapEditorWithSkillActivation } from "../src/agent/dynamic-tools.js";
import { runToolViaPi, resultText } from "./helpers/pi-tool-exec.js";

const ROOM = "matrix:miku:room:!work:example.org";
const SECRET_DM = "matrix:miku:dm:!secret:example.org";

async function withStorage(fn: (s: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await fn(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

async function addSession(
  storage: Storage,
  id: string,
  opts: { timelineKey?: string; status?: "completed" | "running" | "interrupted" | "discarded"; transcript?: AgentMessage[] } = {},
): Promise<void> {
  const now = Date.now();
  await storage.insertAgentSession({
    id,
    timelineKey: opts.timelineKey ?? ROOM,
    sessionType: "default",
    status: opts.status ?? "completed",
    createdAt: now,
    updatedAt: now,
  });
  if (opts.transcript) await storage.saveAgentSessionTranscript(id, JSON.stringify(opts.transcript));
  await storage.waitForIdle();
}

function toolPair(name: string, args: Record<string, unknown>, result: string, id: string): AgentMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: args }],
      api: "anthropic-messages",
      provider: "test",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 0,
    } as AgentMessage,
    { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: result }], details: null, isError: false, timestamp: 0 } as AgentMessage,
  ];
}

function recordTools(ctx: ReadSessionRecordToolContext): AgentTool[] {
  return [createReadSessionRecordTool(ctx), createReadSessionTranscriptTool(ctx)];
}

// ── read_session_record ──────────────────────────────────────────────────────

test("read_session_record: returns the record, builds_on one hop, and the transcript pointer", async () => {
  await withStorage(async (storage) => {
    await addSession(storage, "s-a");
    await storage.upsertSessionRecord({
      session_id: "s-a", timeline_key: ROOM, text: "Found the paper at example.org/p.pdf.",
      token_count: 10, builds_on: ["s-prev"], created_at: Date.now(),
    });
    await storage.waitForIdle();
    const res = await runToolViaPi(recordTools({ storage }), "read_session_record", { session_id: "s-a" });
    assert.equal(res.isError, false);
    const text = resultText(res);
    assert.match(text, /example\.org\/p\.pdf/);
    assert.match(text, /s-prev/);
    assert.match(text, /one hop/);
    assert.match(text, /read_session_transcript\(session_id: "s-a"/);
  });
});

test("read_session_record: no record is an error on the wire, pointing at the transcript tool", async () => {
  await withStorage(async (storage) => {
    await addSession(storage, "s-none");
    const res = await runToolViaPi(recordTools({ storage }), "read_session_record", { session_id: "s-none" });
    assert.equal(res.isError, true);
    assert.match(resultText(res), /No record for session "s-none"/);
    assert.match(resultText(res), /read_session_transcript\(session_id: "s-none"\)/);
  });
});

test("read_session_record: unknown session id is an error naming where the id comes from", async () => {
  await withStorage(async (storage) => {
    const res = await runToolViaPi(recordTools({ storage }), "read_session_record", { session_id: "nope" });
    assert.equal(res.isError, true);
    assert.match(resultText(res), /agent_session_id/);
  });
});

test("read_session_record: a record still being written is an error telling to retry", async () => {
  await withStorage(async (storage) => {
    await addSession(storage, "s-busy");
    const ctx = { storage, isRecordInFlight: (id: string) => id === "s-busy" };
    const res = await runToolViaPi(recordTools(ctx), "read_session_record", { session_id: "s-busy" });
    assert.equal(res.isError, true);
    assert.match(resultText(res), /still being written/);
    assert.match(resultText(res), /read_session_record\(session_id: "s-busy"\) again/);
  });
});

test("read_session_record + transcript: isolated channel outside this session is refused", async () => {
  await withStorage(async (storage) => {
    await addSession(storage, "s-secret", { timelineKey: SECRET_DM, transcript: toolPair("web_fetch", { url: "u" }, "r", "t1") });
    await storage.upsertSessionRecord({ session_id: "s-secret", timeline_key: SECRET_DM, text: "secret", token_count: 1, created_at: 1 });
    await storage.waitForIdle();
    const ctx: ReadSessionRecordToolContext = {
      storage,
      currentTimelineKey: ROOM,
      visibilityResolver: new ChannelVisibilityResolver({ dms: "isolated" }),
    };
    for (const name of ["read_session_record", "read_session_transcript"]) {
      const res = await runToolViaPi(recordTools(ctx), name, { session_id: "s-secret" });
      assert.equal(res.isError, true, name);
      assert.match(resultText(res), /isolated channel/, name);
      assert.doesNotMatch(resultText(res), /secret"?$/, name);
    }
    // Inside the same isolated channel it is readable.
    const same = await runToolViaPi(
      recordTools({ ...ctx, currentTimelineKey: SECRET_DM }),
      "read_session_record",
      { session_id: "s-secret" },
    );
    assert.equal(same.isError, false);
  });
});

test("read_session_record: another agent's session is refused", async () => {
  await withStorage(async (storage) => {
    await addSession(storage, "s-other", { timelineKey: "matrix:chen:room:!work:example.org" });
    const ctx: ReadSessionRecordToolContext = {
      storage,
      currentAgentName: "miku",
      resolveAgentForTimeline: (key) => (key.startsWith("matrix:chen:") ? "chen" : "miku"),
    };
    const res = await runToolViaPi(recordTools(ctx), "read_session_record", { session_id: "s-other" });
    assert.equal(res.isError, true);
    assert.match(resultText(res), /another agent/);
  });
});

test("read_session_record: the gate reads session metadata only, never the payload blobs", async () => {
  await withStorage(async (storage) => {
    await addSession(storage, "s-meta", { transcript: toolPair("x", {}, "y", "t1") });
    await storage.upsertSessionRecord({ session_id: "s-meta", timeline_key: ROOM, text: "rec", token_count: 1, created_at: 1 });
    await storage.waitForIdle();
    const guarded = Object.create(storage) as Storage;
    guarded.getAgentSession = () => {
      throw new Error("full session row (with blobs) loaded");
    };
    const res = await runToolViaPi(recordTools({ storage: guarded }), "read_session_record", { session_id: "s-meta" });
    assert.equal(res.isError, false, resultText(res));
  });
});

test("read_session_record: as a synthetic injection, a missing record lands as an isError result", async () => {
  await withStorage(async (storage) => {
    await addSession(storage, "s-none");
    const messages = await executeSyntheticCalls(
      [{ name: "read_session_record", params: { session_id: "s-none" }, harness: { kind: "injection" } }],
      recordTools({ storage }),
      { api: "anthropic-messages", provider: "test", model: "m" },
    );
    assert.equal((messages[1] as { isError?: boolean }).isError, true);
  });
});

// ── read_session_transcript ──────────────────────────────────────────────────

test("read_session_transcript: a match deep inside a long result is shown in context", async () => {
  await withStorage(async (storage) => {
    const filler = "Unrelated paragraph about nothing in particular. ".repeat(400);
    const longResult = `${filler}The source was https://archive.example.net/scan-42.png per the index.${filler}`;
    await addSession(storage, "s-deep", { transcript: toolPair("web_fetch", { url: "https://example.net" }, longResult, "t1") });
    const res = await runToolViaPi(recordTools({ storage }), "read_session_transcript", {
      session_id: "s-deep",
      query: "scan-42",
    });
    assert.equal(res.isError, false);
    const text = resultText(res);
    assert.match(text, /archive\.example\.net\/scan-42\.png/);
    assert.match(text, /1 match\(es\), shown in context/);
    assert.ok(text.length < longResult.length / 4, `output not bounded: ${text.length} chars`);
  });
});

test("read_session_transcript: an unqueried long result is clipped with a marker naming `query`", async () => {
  await withStorage(async (storage) => {
    const longResult = "word ".repeat(5000);
    await addSession(storage, "s-head", { transcript: toolPair("web_fetch", {}, longResult, "t1") });
    const res = await runToolViaPi(recordTools({ storage }), "read_session_transcript", { session_id: "s-head" });
    const text = resultText(res);
    assert.match(text, /result clipped: first ~512 of ~\d+ tokens\. Pass query:/);
    assert.doesNotMatch(text, /pagination|narrow`?/i, "no promise of a parameter that does not exist");
  });
});

test("read_session_transcript: output is bounded and pages with offset", async () => {
  await withStorage(async (storage) => {
    const transcript: AgentMessage[] = [];
    for (let i = 1; i <= 30; i++) transcript.push(...toolPair("web_fetch", { url: `u${i}` }, `page ${i} ${"text ".repeat(300)}`, `t${i}`));
    await addSession(storage, "s-many", { transcript });
    const tools = recordTools({ storage });

    const first = await runToolViaPi(tools, "read_session_transcript", { session_id: "s-many" });
    const firstText = resultText(first);
    const m = /Shown matching calls 1–(\d+) of 30\. Next page: the same call with offset: (\d+)\./.exec(firstText);
    assert.ok(m, `expected a paging footer: ${firstText.slice(-300)}`);
    assert.equal(m![1], m![2]);
    const shown = Number(m![1]);
    assert.ok(shown > 0 && shown < 30);

    const second = await runToolViaPi(tools, "read_session_transcript", { session_id: "s-many", offset: shown });
    const secondText = resultText(second);
    assert.match(secondText, new RegExp(`Shown matching calls ${shown + 1}–`));
    assert.match(secondText, new RegExp(`"url":"u${shown + 1}"`));
    assert.doesNotMatch(secondText, /"url":"u1"/);

    const past = await runToolViaPi(tools, "read_session_transcript", { session_id: "s-many", offset: 30 });
    assert.equal(past.isError, true);
    assert.match(resultText(past), /offset 30 is past the last matching call \(30 match\)/);
  });
});

test("read_session_transcript: no transcript yet / reversed range are errors with the fix", async () => {
  await withStorage(async (storage) => {
    await addSession(storage, "s-run", { status: "running" });
    await addSession(storage, "s-ok", { transcript: toolPair("a", {}, "b", "t1") });
    const tools = recordTools({ storage });
    const running = await runToolViaPi(tools, "read_session_transcript", { session_id: "s-run" });
    assert.equal(running.isError, true);
    assert.match(resultText(running), /still running/);
    const reversed = await runToolViaPi(tools, "read_session_transcript", { session_id: "s-ok", range: [3, 1] });
    assert.equal(reversed.isError, true);
    assert.match(resultText(reversed), /pass \[1, 3\]/);
  });
});

test("read_session_transcript: no matching call is a successful answer with a hint", async () => {
  await withStorage(async (storage) => {
    await addSession(storage, "s-q", { transcript: toolPair("web_fetch", { url: "a" }, "b", "t1") });
    const res = await runToolViaPi(recordTools({ storage }), "read_session_transcript", { session_id: "s-q", query: "zebra" });
    assert.equal(res.isError, false);
    assert.match(resultText(res), /0 matching call\(s\)\. Turns run 1–1/);
  });
});

// ── record-turn gate ─────────────────────────────────────────────────────────

function plainTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} } as never,
    execute: async () => ({ content: [{ type: "text", text: `${name} ran` }], details: null }),
  };
}

test("record-turn gate: outside the record turn session_record_tool is an error on the wire", async () => {
  const gate = { active: false };
  const tools = wrapToolsWithRecordTurnGate(
    [plainTool("web_fetch"), createSessionRecordTool({ draft: new SummaryDraft(), maxTokens: 100 })],
    gate,
  );
  const blocked = await runToolViaPi(tools, "session_record_tool", { command: "view" });
  assert.equal(blocked.isError, true);
  assert.match(resultText(blocked), /only used by the harness at the end of a session/);
  const allowed = await runToolViaPi(tools, "web_fetch", {});
  assert.equal(allowed.isError, false);
  assert.equal(resultText(allowed), "web_fetch ran");
});

test("record-turn gate: during the record turn every other tool is an error naming the record tool", async () => {
  const gate = { active: true };
  const draft = new SummaryDraft();
  const tools = wrapToolsWithRecordTurnGate(
    [plainTool("web_fetch"), createSessionRecordTool({ draft, maxTokens: 100 })],
    gate,
  );
  const blocked = await runToolViaPi(tools, "web_fetch", {});
  assert.equal(blocked.isError, true);
  assert.match(resultText(blocked), /Only session_record_tool is available while writing the session record/);
  const allowed = await runToolViaPi(tools, "session_record_tool", { command: "create", file_text: "rec" });
  assert.equal(allowed.isError, false);
  assert.equal(draft.getContent(), "rec");
});

test("record-turn gate: a gate-blocked editor view activates no skill tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-gate-"));
  try {
    await mkdir(path.join(root, "skills", "s"), { recursive: true });
    await writeFile(path.join(root, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\ntools:\n  - web_fetch\n---\nbody\n");
    const editor: AgentTool = {
      ...plainTool("str_replace_based_edit_tool"),
      parameters: { type: "object", properties: { command: { type: "string" }, path: { type: "string" } } } as never,
    };
    const gate = { active: true };
    const [gatedEditor] = wrapToolsWithRecordTurnGate([editor], gate);
    let registry: DynamicToolRegistry | undefined;
    const wrapped = wrapEditorWithSkillActivation(gatedEditor, {
      workspaceRoot: root,
      getRegistry: () => registry,
      sessionId: "s",
    });
    registry = new DynamicToolRegistry([wrapped, plainTool("web_fetch")], ["str_replace_based_edit_tool"]);

    const blocked = await runToolViaPi([wrapped], "str_replace_based_edit_tool", { command: "view", path: "skills/s/SKILL.md" });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.addedToolNames, undefined);
    assert.equal(registry.isLoaded("web_fetch"), false, "a failed view must not load tools");

    gate.active = false;
    const ok = await runToolViaPi([wrapped], "str_replace_based_edit_tool", { command: "view", path: "skills/s/SKILL.md" });
    assert.equal(ok.isError, false);
    assert.equal(registry.isLoaded("web_fetch"), true, "a successful view still activates");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("read_session_record: durable generation outcomes have distinct actionable errors", async () => {
  await withStorage(async (storage) => {
    const cases = [
      ["skipped", "no_work", /work gate found no non-exempt tool work/],
      ["skipped", "empty", /explicitly chose not to save/],
      ["failed", "refusal", /record writer refused/],
      ["failed", "budget_blocked", /budget was exhausted/],
      ["writing", null, /previous attempt was interrupted/],
    ] as const;
    for (const [status, reason, expected] of cases) {
      if (!storage.getAgentSessionMeta("s-status")) await addSession(storage, "s-status");
      await storage.setSessionRecordGeneration("s-status", status, reason);
      const res = await runToolViaPi(recordTools({ storage }), "read_session_record", { session_id: "s-status" });
      assert.equal(res.isError, true);
      assert.match(resultText(res), expected);
    }
    for (const status of ["interrupted", "discarded"] as const) {
      await addSession(storage, `s-${status}`, { status });
      const result = await runToolViaPi(recordTools({ storage }), "read_session_record", { session_id: `s-${status}` });
      assert.match(resultText(result), new RegExp(`session was ${status}`));
    }
    await addSession(storage, "s-running", { status: "running" });
    const pending = await runToolViaPi(recordTools({ storage }), "read_session_record", { session_id: "s-running" });
    assert.match(resultText(pending), /session has not finished/);
  });
});


test("read_session_record: historical harness outcome is used without guessing a work-gate result", async () => {
  await withStorage(async (storage) => {
    await addSession(storage, "s-legacy", { transcript: [{ role: "user", content: "synthetic harness", timestamp: 1,
      harness: { kind: "record_turn", status: "failed", reason: "not_finalized" } } as any] });
    const result = await runToolViaPi(recordTools({ storage }), "read_session_record", { session_id: "s-legacy" });
    assert.match(resultText(result), /did not finalize/);
  });
});
