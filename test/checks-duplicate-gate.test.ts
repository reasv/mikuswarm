import assert from "node:assert/strict";
import test from "node:test";

import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { withSeenStamp } from "../src/checks/duplicate.js";
import { createDuplicateSource } from "../src/checks/duplicate-source.js";
import { CheckEvaluator } from "../src/checks/evaluator.js";
import { OBSERVE_POLICY, OutputGate, wrapToolsWithOutputGate, type GatePolicy } from "../src/checks/gate.js";
import { createRevisePolicyPart } from "../src/checks/revise.js";
import type { AgentSessionRecord } from "../src/agent/session-manager.js";
import { DecisionClient, DecisionEngine } from "../src/decisions/index.js";
import { Storage } from "../src/storage/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import { ChannelVisibilityResolver, type VisibilityConfig } from "../src/visibility/index.js";

// ---------------------------------------------------------------------------
// The duplicate-send check through a real OutputGate, evaluator, decision
// engine (fake transport) and in-memory storage (ARCHITECTURE.md §8j
// "Duplicate sends"): the mechanical pre-gate, what counts as seen, the state,
// the questions and their error text, overrides, bounds, fail-open, every
// posting tool's target timeline, proactive sessions, and the last-seen point
// of redone, revived and resumed sessions.
// ---------------------------------------------------------------------------

const OWN = "matrix:acct:room:!r:example.org";
const OTHER = "matrix:acct:room:!other:example.org";
const DM = "matrix:acct:dm:!dm:example.org";
/** The same room seen by another agent's account. */
const B_ROOM = "matrix:acct_b:room:!r:example.org";
const SELF = "s-self0001";
// The `receivedAt` clock is the wall clock: the build cutoff a minute ago.
const CUTOFF = Date.now() - 60_000;
const DUPLICATE_NAMES = ["answered_already", "repeats", "contradicts"] as const;

function decider(): any {
  return {
    id: "vendor/decider-1",
    provider: "openrouter",
    api: "system-one",
    endpoint: "https://gw.example/decisions",
    api_key: "k",
    input_modalities: ["text"],
    max_tokens: 1,
    context_window: 32000,
    cost: { input: 0.04, output: 0, cache_read: 0.04, cache_write: 0.04 },
  };
}

interface SetupOpts {
  /** Probability per question name (default 0.1); called with the state. */
  answer?: (name: string, state: any) => number;
  /** The decision endpoint fails. */
  failing?: boolean;
  knobs?: Record<string, unknown>;
  checks?: Record<string, unknown>;
  sessionType?: string;
  trigger?: Partial<CanonicalChatEvent>;
  /** The live messages (default: a head stamped with CUTOFF). */
  messages?: any[];
  storage?: Storage;
  /** Awaited before a duplicate call is answered (n = 1 for the first). */
  onDuplicateCall?: (n: number, state: any) => Promise<void> | void;
  /** Probability for non-duplicate question ids (default 0.01). */
  otherAnswer?: (id: string) => number;
  /** `[visibility]` (absent = everything readable). */
  visibility?: VisibilityConfig;
}

function event(id: string, body: string, over: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id,
    timelineKey: OWN,
    provider: "matrix",
    role: "assistant",
    sender: { id: "@bot:example.org", displayName: "Bot", isSelf: true },
    body,
    timestamp: over.receivedAt ?? 1000,
    receivedAt: 1000,
    ...over,
  };
}

async function newStorage(): Promise<Storage> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const session = (id: string, timelineKey: string, over: Record<string, unknown> = {}) =>
    storage.insertAgentSession({
      id,
      timelineKey,
      sessionType: "default",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
      triggerEventId: `t-${id}`,
      triggerBody: "what is 6 times 7?",
      triggerSenderId: "@alice:example.org",
      triggerSenderDisplayName: "alice",
      ...over,
    } as never);
  await session(SELF, OWN, { triggerBody: "6*7?", triggerSenderDisplayName: "bob" });
  await session("s-other001", OWN);
  await session("s-proact01", OWN, { sessionType: "proactive", triggerEventId: "proactive-abc", triggerBody: "" });
  await session("s-agentb01", B_ROOM);
  return storage;
}

/** Another session's bot message stored at `receivedAt`. */
async function botMessage(storage: Storage, id: string, body: string, receivedAt: number, sessionId = "s-other001", timelineKey = OWN) {
  await storage.appendTimelineEvent(event(id, body, { receivedAt, timestamp: receivedAt, timelineKey, agentSessionId: sessionId }), "complete");
}

const head = (upTo = CUTOFF) => withSeenStamp({ type: "triggerGroup", content: "trigger", timestamp: 5 }, { timelineKey: OWN, upTo });

/** The session's acting policy, reduced to its revise half (no refusal rule acts). */
function revisePolicy(revise: ReturnType<typeof createRevisePolicyPart>): GatePolicy {
  return {
    shouldHold: (info, checks) => revise.shouldHold(info, checks),
    consequence: (info, verdict, opts) => {
      if (verdict.revise.length > 0) {
        const decision = revise.decide(info, verdict);
        if (decision.consequence) return decision.consequence;
      }
      return OBSERVE_POLICY.consequence(info, verdict, opts);
    },
    refusalOutcome: () => ({ outcome: "observed" }),
    act: (info, verdict) => {
      const decision = revise.decide(info, verdict);
      return decision.kind === "block" ? { kind: "block", message: decision.message } : { kind: "proceed" };
    },
    onDelivered: () => revise.onDelivered(),
  };
}

let callSeq = 0;

async function setup(opts: SetupOpts = {}) {
  const config: any = {
    models: { decider: decider() },
    decisions: {
      enabled: true,
      model: "decider",
      checks: { enabled: true, timeout_ms: 60_000, ...(opts.knobs ?? {}) },
    },
    checks: opts.checks ?? { duplicate: { enabled: true } },
    agents: {},
  };
  const storage = opts.storage ?? (await newStorage());
  const lines: Array<[string, any]> = [];
  const l: any = {
    info: (e: string, f: any) => lines.push([e, f]),
    warn: (e: string, f: any) => lines.push([e, f]),
    error: (e: string, f: any) => lines.push([e, f]),
    debug: (e: string, f: any) => lines.push([e, f]),
    child() {
      return l;
    },
  };
  const decisions: Array<{ state: any; questions: Record<string, any> }> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    // The built-in refusal checks are judged too (their own call): answered "no", not counted.
    const duplicateCall = Object.keys(body.questions).some((id) => id.startsWith("duplicate__"));
    if (duplicateCall) {
      decisions.push({ state: body.state, questions: body.questions });
      await opts.onDuplicateCall?.(decisions.length, body.state);
    }
    if (opts.failing) return new Response("upstream down", { status: 500 });
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) {
      const name = id.replace(/^duplicate__/, "");
      answers[id] = { noul: duplicateCall ? (opts.answer?.(name, body.state) ?? 0.1) : (opts.otherAnswer?.(id) ?? 0.01) };
    }
    return new Response(JSON.stringify({ model: "vendor/decider-1", answers, usage: { input_tokens: 10, output_tokens: 1, cost: 0 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const engine = new DecisionEngine({
    config,
    client: new DecisionClient({ models: config.models, fetchImpl, logger: l }),
    record: () => {},
    logger: l,
  });
  const catalogue = buildCheckCatalogue(config);
  const evaluator = new CheckEvaluator({ catalogue, engine, config, storage, logger: l });
  const revise = createRevisePolicyPart({ evaluator, logger: l });
  const messages: any[] = opts.messages ?? [head()];
  const sessionType = opts.sessionType ?? "default";
  const record: AgentSessionRecord = {
    id: SELF,
    timelineKey: OWN,
    sessionType,
    status: "running",
    createdAt: 1,
    trigger: {
      provider: "matrix",
      timelineKey: OWN,
      event: event("t-self", "6*7?", {
        role: "user",
        sender: { id: "@bob:example.org", displayName: "bob" },
        ...(opts.trigger ?? {}),
      }),
    },
  };
  const agentFor = (key: string) => (key.startsWith("matrix:acct_b:") ? "agent_b" : "agent_a");
  const duplicate = createDuplicateSource(
    {
      storage,
      agentFor,
      proactiveSessionType: "proactive",
      ...(opts.visibility
        ? {
            readGate: (timelineKey: string) => ({
              currentTimelineKey: timelineKey,
              visibilityResolver: new ChannelVisibilityResolver(opts.visibility),
            }),
          }
        : {}),
    },
    () => new Set(["duplicate"]),
  )(record, "agent_a");
  const gate = new OutputGate({
    evaluator,
    scope: { agent: null, site: sessionType, sessionId: SELF, sessionType, timelineKey: OWN, tasks: null },
    getMessages: () => messages,
    chat: () => ({ request: [{ from: "bob", text: "6*7?" }], recent: [] }),
    servingModel: () => "model_a",
    policy: revisePolicy(revise),
    duplicate,
    logger: l,
  });
  const sent: Array<[string, any]> = [];
  const fake = (name: string) =>
    ({
      name,
      label: name,
      description: name,
      parameters: { type: "object", properties: {} },
      execute: async (_id: string, params: any) => {
        sent.push([name, params]);
        return { content: [{ type: "text", text: "sent: $e1" }], details: {} };
      },
    }) as any;
  const names = ["send_message", "send_to_channel", "send_dm", "edit_message", "create_poll"];
  const tools = new Map(wrapToolsWithOutputGate(names.map(fake), gate).map((t) => [t.name, t]));
  /**
   * Call a posting tool the way the agent loop does, appending the call and its
   * result to the live messages; returns "sent" or the error text.
   */
  const call = async (args: Record<string, unknown>, tool = "send_message"): Promise<string> => {
    const id = `dup-call-${++callSeq}`;
    messages.push({ role: "assistant", content: [{ type: "toolCall", id, name: tool, arguments: args }], timestamp: 2 });
    let text: string;
    let outcome: string;
    try {
      await tools.get(tool)!.execute(id, args as any, undefined, undefined);
      text = "sent: $e1";
      outcome = "sent";
    } catch (error) {
      text = (error as Error).message;
      outcome = text;
    }
    messages.push({ role: "toolResult", toolCallId: id, toolName: tool, content: [{ type: "text", text }], isError: outcome !== "sent", timestamp: 3 });
    return outcome;
  };
  const consequences = async () => {
    // Unheld evaluations record when they complete.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await storage.waitForIdle();
    // One entry per judged call and consequence (a send's refusal and duplicate calls share both).
    const rows = storage.getDecisionEvaluationsForSession(SELF).map((r) => `${r.tool_call_id}|${r.consequence}`);
    return [...new Set(rows)].map((r) => r.split("|") as [string, string]);
  };
  return { storage, gate, revise, call, sent, lines, decisions, messages, consequences };
}

const skipped = (lines: Array<[string, any]>) => lines.filter(([e]) => e === "check_duplicate_skipped").map(([, f]) => f.reason);

test("pre-gate: no unseen message means no decision call (a debug line), and the send goes out", async () => {
  const storage = await newStorage();
  // Before the build cutoff (seen in the context) and the session's own message: not unseen.
  await botMessage(storage, "e-old", "It's 42.", CUTOFF - 1);
  await botMessage(storage, "e-mine", "my own", CUTOFF + 5, SELF);
  const t = await setup({ storage, answer: () => 0.99 });
  assert.equal(await t.call({ message: "The answer is 42." }), "sent");
  assert.equal(t.decisions.length, 0, "no decision call");
  assert.deepEqual(skipped(t.lines), ["no_unseen"]);
  await t.consequences();
  assert.ok(
    t.storage.getDecisionEvaluationsForSession(SELF).every((r) => !(r.questions_json ?? "").includes("duplicate__")),
    "no duplicate row (only the built-in refusal checks were judged)",
  );
  storage.close();
});

test("pre-gate: another agent's message never counts", async () => {
  const storage = await newStorage();
  // Agent B's session stored in agent A's room timeline (and in its own): neither is compared.
  await botMessage(storage, "e-b1", "It's 42.", CUTOFF + 100, "s-agentb01");
  await botMessage(storage, "e-b2", "It's 42.", CUTOFF + 100, "s-agentb01", B_ROOM);
  const t = await setup({ storage, answer: () => 0.99 });
  assert.equal(await t.call({ message: "The answer is 42." }), "sent");
  assert.equal(t.decisions.length, 0);
  storage.close();
});

for (const name of DUPLICATE_NAMES) {
  test(`question ${name}: at its threshold it blocks with the spec's error naming it; the override sends`, async () => {
    const storage = await newStorage();
    await botMessage(storage, "e1", "It's 42.", CUTOFF + 1000);
    const t = await setup({ storage, answer: (q) => (q === name ? 0.8 : 0.79) });
    const error = await t.call({ message: "The answer is 42." });
    const clause = {
      answered_already: "answers the same question it already answered",
      repeats: "repeats what that message already says",
      contradicts: "contradicts it",
    }[name];
    assert.match(
      error,
      new RegExp(
        "^Not sent\\. Another session of yours \\(you, answering a different message in this room in parallel\\) " +
          "already posted a message here \\d+ s ago that you have not seen: «It's 42\\.» \\(it was answering alice: " +
          `«what is 6 times 7\\?»\\)\\. Your draft ${clause}\\. Rewrite your message so it fits after that one: refer ` +
          "to it, correct it, or add only what is new\\. Call no_reply if nothing is left to add\\. If your draft is " +
          'still right as written, send it again with override_checks: \\["duplicate"\\]\\.$',
      ),
    );
    assert.equal(t.sent.length, 0);
    // The state the decision model saw: exactly earlier[] and draft.
    const { state, questions } = t.decisions[0]!;
    assert.deepEqual(Object.keys(questions), ["duplicate__answered_already", "duplicate__repeats", "duplicate__contradicts"]);
    assert.deepEqual(state.earlier.map((m: any) => [m.answering, m.text]), [[{ from: "alice", text: "what is 6 times 7?" }, "It's 42."]]);
    assert.deepEqual(state.draft, { answering: { from: "bob", text: "6*7?" }, text: "The answer is 42." });
    // Meanwhile another message lands; the agent decides its draft is still right:
    // the duplicate check fires again and the override sends it anyway.
    await botMessage(storage, "e2", "Yes, 42.", CUTOFF + 2000);
    assert.equal(await t.call({ message: "The answer is 42.", override_checks: ["duplicate"] }), "sent");
    assert.deepEqual(t.sent, [["send_message", { message: "The answer is 42." }]]);
    assert.deepEqual(t.decisions[1]!.state.earlier.map((m: any) => m.text), ["Yes, 42."], "only the newer message");
    const rows = await t.consequences();
    assert.deepEqual(rows.map(([, c]) => c), ["revise", "overridden"]);
    storage.close();
  });
}

test("rejection: the quoted messages count as seen; the next draft is compared only against newer ones", async () => {
  const storage = await newStorage();
  await botMessage(storage, "e1", "It's 42.", CUTOFF + 1000);
  const t = await setup({ storage, answer: (q) => (q === "repeats" ? 0.95 : 0.1) });
  assert.match(await t.call({ message: "The answer is 42." }), /^Not sent/);
  // Rewritten: nothing newer was posted, so no call is made.
  assert.equal(await t.call({ message: "As my other reply said: 42." }), "sent");
  assert.equal(t.decisions.length, 1);
  assert.deepEqual(skipped(t.lines), ["no_unseen"]);
  // Another message lands later: only it is compared.
  await botMessage(storage, "e2", "Also, 6*7 is 42 in base 10.", CUTOFF + 5000);
  assert.match(await t.call({ message: "In base 10 that's 42." }), /^Not sent/);
  assert.deepEqual(t.decisions[1]!.state.earlier.map((m: any) => m.text), ["Also, 6*7 is 42 in base 10."]);
  storage.close();
});

test("an interjection that quoted a message: it counts as seen", async () => {
  const storage = await newStorage();
  await botMessage(storage, "e1", "It's 42.", CUTOFF + 1000);
  const messages = [head(), { type: "interjection", content: "<interjection>…</interjection>", seen: { eventIds: ["e1"] } }];
  const t = await setup({ storage, messages, answer: () => 0.99 });
  assert.equal(await t.call({ message: "The answer is 42." }), "sent");
  assert.equal(t.decisions.length, 0);
  storage.close();
});

test("bounds: after revise_max_consecutive rejections the next send goes through, recorded `sent`", async () => {
  const storage = await newStorage();
  await botMessage(storage, "e1", "It's 42.", CUTOFF + 1000);
  await botMessage(storage, "e2", "Really, 42.", CUTOFF + 1500);
  await botMessage(storage, "e3", "Still 42.", CUTOFF + 1800);
  const t = await setup({ storage, knobs: { revise_max_consecutive: 2 }, answer: () => 0.95 });
  // Each rejection quotes the unseen messages: make each next one see a newer message.
  assert.match(await t.call({ message: "42" }), /^Not sent/);
  await botMessage(storage, "e4", "42 again.", CUTOFF + 2000);
  assert.match(await t.call({ message: "42!" }), /^Not sent/);
  await botMessage(storage, "e5", "and 42.", CUTOFF + 2500);
  assert.equal(await t.call({ message: "42!!" }), "sent", "the third attempt goes through regardless");
  const rows = await t.consequences();
  assert.deepEqual(rows.map(([, c]) => c), ["revise", "revise", "sent"]);
  assert.ok(t.lines.some(([e, f]) => e === "check_revise_bound_passed" && f.bound === "consecutive"));
  storage.close();
});

test("fail-open: a failing chain lets the send go out unjudged", async () => {
  const storage = await newStorage();
  await botMessage(storage, "e1", "It's 42.", CUTOFF + 1000);
  const t = await setup({ storage, failing: true });
  assert.equal(await t.call({ message: "The answer is 42." }), "sent");
  assert.ok(t.decisions.length >= 1, "the chain was asked");
  assert.deepEqual((await t.consequences()).map(([, c]) => c), ["sent_unjudged"]);
  storage.close();
});

test("every posting tool is judged against its own target timeline", async () => {
  const storage = await newStorage();
  await botMessage(storage, "e-own", "Here: 42.", CUTOFF + 1000);
  await botMessage(storage, "e-other", "Over there: 42.", CUTOFF + 1000, "s-other001", OTHER);
  await botMessage(storage, "e-dm", "In the DM: 42.", CUTOFF + 1000, "s-other001", DM);
  await storage.setDmPeer("matrix", "acct", "!dm:example.org", "@carol:example.org");
  const t = await setup({ storage, answer: () => 0.1 });
  const earlierOf = () => t.decisions.at(-1)!.state.earlier.map((m: any) => m.text);
  assert.equal(await t.call({ message: "42", channel: OTHER, context_note: "n" }, "send_to_channel"), "sent");
  assert.deepEqual(earlierOf(), ["Over there: 42."]);
  assert.equal(await t.call({ user: "@carol:example.org", message: "42", context_note: "n" }, "send_dm"), "sent");
  assert.deepEqual(earlierOf(), ["In the DM: 42."]);
  const judged = t.decisions.length;
  assert.equal(await t.call({ message_id: "$m", text: "edited: 42" }, "edit_message"), "sent");
  assert.equal(t.decisions.length, judged, "an edit is not judged");
  assert.equal(skipped(t.lines).at(-1), "edit");
  assert.equal(await t.call({ question: "42?", options: ["yes", "no"] }, "create_poll"), "sent");
  assert.deepEqual(earlierOf(), ["Here: 42."]);
  assert.equal(t.decisions.at(-1)!.state.draft.text, "42? - yes - no", "the poll's question and options");
  assert.equal(await t.call({ message: "42" }), "sent");
  assert.deepEqual(earlierOf(), ["Here: 42."]);
  // A DM with nobody known yet: nothing to compare.
  assert.equal(await t.call({ user: "@dave:example.org", message: "42", context_note: "n" }, "send_dm"), "sent");
  assert.equal(skipped(t.lines).at(-1), "no_target");
  storage.close();
});

test("proactive sessions are checked; their draft and earlier proactive posts are unprompted", async () => {
  const storage = await newStorage();
  await botMessage(storage, "e1", "Morning everyone!", CUTOFF + 1000, "s-proact01");
  const t = await setup({
    storage,
    sessionType: "proactive",
    trigger: { id: "proactive-xyz", body: "", sender: { id: "@bot:example.org", displayName: "Bot", isSelf: true }, trigger: { type: "timer", reason: "proactive" } as never },
    answer: (q) => (q === "repeats" ? 0.9 : 0.1),
  });
  const error = await t.call({ message: "Good morning all!" });
  assert.match(error, /^Not sent\. Another session of yours \(you, posting on your own in parallel\)/);
  assert.match(error, /\(it was not answering anyone: you posted it on your own\)/);
  const state = t.decisions[0]!.state;
  assert.equal(state.draft.answering, "unprompted");
  assert.equal(state.earlier[0].answering, "unprompted");
  storage.close();
});

test("last seen: a redo rebuild sees the room up to its (first) cutoff; a revival keeps it; a resume reads rejections back", async () => {
  const storage = await newStorage();
  await botMessage(storage, "e1", "It's 42.", CUTOFF + 1000);
  // Redo: the rebuilt context reuses the first cutoff, so e1 (after it) is still unseen.
  const redone = await setup({ storage, messages: [head(CUTOFF)], answer: (q) => (q === "repeats" ? 0.9 : 0.1) });
  assert.match(await redone.call({ message: "42" }), /^Not sent/);
  // A build that read e1 (cutoff after it) has seen it.
  const later = await setup({ storage, messages: [head(CUTOFF + 2000)], answer: () => 0.9 });
  assert.equal(await later.call({ message: "42" }), "sent");
  assert.equal(later.decisions.length, 0);
  // Revival: the transcript goes on with a revival interjection (it shows no room); e1 stays unseen.
  const revived = await setup({
    storage,
    messages: [head(CUTOFF), { role: "assistant", content: [{ type: "text", text: "hm" }] }, { type: "interjection", content: "alice sent this before your reply reached them." }],
    answer: (q) => (q === "contradicts" ? 0.9 : 0.1),
  });
  assert.match(await revived.call({ message: "41" }), /Your draft contradicts it\./);
  // Resume: a new gate over the persisted transcript; the earlier rejection, read back
  // from the session's rows, still counts its quoted message as seen.
  await redone.consequences();
  const resumed = await setup({ storage, messages: [...redone.messages], answer: () => 0.9 });
  assert.equal(await resumed.call({ message: "As I said elsewhere, 42." }), "sent");
  assert.equal(resumed.decisions.length, 0, "e1 was quoted by the earlier rejection");
  storage.close();
});

/** Mark a stored message deleted at `at`. */
async function deleteMessage(storage: Storage, id: string, at: number) {
  const event = storage.getTimelineEventById(id)!;
  await storage.appendTimelineEvent({ ...event, deleted: { at } }, "complete");
}

test("deleted messages: one another session deleted does not count; deleting a quoted one changes nothing", async () => {
  const storage = await newStorage();
  await botMessage(storage, "e1", "It's 42.", CUTOFF + 1000);
  await botMessage(storage, "e2", "It's 41.", CUTOFF + 1200);
  await deleteMessage(storage, "e2", Date.now() - 1000);
  // A marker dated after the evaluation (the provider's clock is ahead) still counts live.
  await botMessage(storage, "e3", "Or 43.", CUTOFF + 1300);
  await deleteMessage(storage, "e3", Date.now() + 60_000);
  const t = await setup({ storage, answer: (q) => (q === "repeats" ? 0.95 : 0.1) });
  assert.match(await t.call({ message: "The answer is 42." }), /^Not sent\. Another session of yours/);
  assert.deepEqual(t.decisions[0]!.state.earlier.map((m: any) => m.text), ["It's 42."]);
  // The quoted message is deleted afterwards: it stays seen, nothing new to compare.
  await deleteMessage(storage, "e1", Date.now());
  assert.equal(await t.call({ message: "As I said: 42." }), "sent");
  assert.equal(t.decisions.length, 1);
  storage.close();
});

test("deleted messages: what an earlier session was answering, deleted since, shows as the placeholder in the state and the error", async () => {
  for (const by of ["@alice:example.org", "@mod:example.org"]) {
    const storage = await newStorage();
    const secret = "what is 6 times 7?";
    // The other session's request (its stored trigger), deleted after it was answered.
    await storage.appendTimelineEvent(
      event("t-s-other001", secret, {
        role: "user",
        sender: { id: "@alice:example.org", displayName: "alice" },
        receivedAt: CUTOFF - 5000,
        timestamp: CUTOFF - 5000,
        deleted: { at: Date.now() - 2000, by },
      }),
      "complete",
    );
    await botMessage(storage, "e1", "It's 42.", CUTOFF + 1000);
    const t = await setup({ storage, answer: (q) => (q === "repeats" ? 0.95 : 0.1) });
    const out = await t.call({ message: "The answer is 42." });
    const placeholder = by === "@mod:example.org" ? "[message deleted by @mod:example.org]" : "[message deleted]";
    const state = JSON.stringify(t.decisions[0]!.state);
    assert.ok(!state.includes(secret), `state quotes the deleted request: ${state}`);
    assert.deepEqual(t.decisions[0]!.state.earlier[0].answering, { from: "alice", text: placeholder });
    assert.ok(!out.includes(secret), out);
    assert.ok(out.includes(`(it was answering alice: ${placeholder})`), out);
    storage.close();
  }
});

test("a message posted while the call waits for its verdict: one more evaluation, never more", async () => {
  const storage = await newStorage();
  await botMessage(storage, "e1", "Let me check.", CUTOFF + 1000);
  const t = await setup({
    storage,
    // The draft repeats only what arrives during the wait.
    answer: (q, state) => (q === "repeats" && state.earlier.some((m: any) => m.text === "It's 42.") ? 0.95 : 0.1),
    onDuplicateCall: async (n) => {
      // Another session posts while this call waits (during both judgements).
      if (n === 1) await botMessage(storage, "e2", "It's 42.", Date.now());
      if (n === 2) await botMessage(storage, "e3", "Definitely 42.", Date.now());
    },
  });
  const error = await t.call({ message: "The answer is 42." });
  assert.match(error, /^Not sent\. Other sessions of yours .* already posted 2 messages here that you have not seen:/s);
  assert.equal(t.decisions.length, 2, "one recheck, no loop");
  assert.deepEqual(t.decisions[1]!.state.earlier.map((m: any) => m.text), ["Let me check.", "It's 42."]);
  assert.ok(t.lines.some(([e, f]) => e === "check_duplicate_rechecked" && f.newMessages === 1));
  const rows = await t.consequences();
  assert.deepEqual(rows.map(([, c]) => c), ["revise"], "one evaluation, recorded once");
  storage.close();
});

test("a recheck past the checkpoint deadline takes the normal late path: the send goes out unjudged", async () => {
  const storage = await newStorage();
  await botMessage(storage, "e1", "Let me check.", CUTOFF + 1000);
  const t = await setup({
    storage,
    knobs: { send_deadline_ms: 400 },
    // The first judgement (e1 only) says no in time; the recheck (e1 + e2) would say yes, too late.
    answer: (_q, state) => (state.earlier.length > 1 ? 0.95 : 0.1),
    onDuplicateCall: async (n) => {
      if (n === 1) await botMessage(storage, "e2", "It's 42.", Date.now());
      if (n === 2) await new Promise((r) => setTimeout(r, 600));
    },
  });
  assert.equal(await t.call({ message: "The answer is 42." }), "sent");
  assert.equal(t.decisions.length, 2);
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual((await t.consequences()).map(([, c]) => c), ["sent_unjudged"]);
  storage.close();
});

const styleQuestion = { source: "message", instructions: "`message` is figurative.", criteria: { true: "t", false: "f" }, threshold: 0.8 };

test("a blocking verdict in hand is never rechecked: a style flag judged in time blocks even when a message arrives meanwhile", async () => {
  const storage = await newStorage();
  await botMessage(storage, "e1", "Let me check.", CUTOFF + 1000);
  const t = await setup({
    storage,
    knobs: { send_deadline_ms: 400 },
    checks: { duplicate: { enabled: true }, style_q: { kind: "style", min_chars: 0, questions: [styleQuestion] } },
    otherAnswer: (id) => (id.startsWith("style_q") ? 0.95 : 0.01),
    onDuplicateCall: async (n) => {
      // Another session posts during the first judgement; a recheck would miss the deadline.
      if (n === 1) await botMessage(storage, "e2", "unrelated", Date.now());
      if (n === 2) await new Promise((r) => setTimeout(r, 600));
    },
  });
  assert.match(await t.call({ message: "The answer is 42." }), /style_q/);
  assert.equal(t.decisions.length, 1, "no recheck once a blocking check fired");
  assert.ok(!t.lines.some(([e]) => e === "check_duplicate_rechecked"));
  assert.deepEqual((await t.consequences()).map(([, c]) => c), ["revise"]);
  storage.close();
});

test("a recheck that misses the deadline acts on the verdict in hand, never on pattern hits alone", async () => {
  const storage = await newStorage();
  await botMessage(storage, "e1", "Let me check.", CUTOFF + 1000);
  const t = await setup({
    storage,
    knobs: { send_deadline_ms: 400 },
    checks: { duplicate: { enabled: true }, style_q: { kind: "style", min_chars: 0, questions: [styleQuestion] } },
    otherAnswer: (id) => (id.startsWith("style_q") ? 0.95 : 0.01),
    onDuplicateCall: async () => {
      await new Promise((r) => setTimeout(r, 600));
    },
  });
  const id = "direct-settle-1";
  const args = { message: "The answer is 42." };
  t.messages.push({ role: "assistant", content: [{ type: "toolCall", id, name: "send_message", arguments: args }], timestamp: 2 });
  const evaluation = t.gate.begin("send", id, t.gate.subjectForCall("send_message", id, args))!;
  // A recheck that extends the evaluation past its deadline (the slow duplicate call).
  const verdict = await t.gate.settle(id, {
    held: true,
    recheck: () =>
      t.gate.evaluator.extendDuplicate(
        evaluation,
        {
          targetTimelineKey: OWN,
          ownTimelineKey: OWN,
          draftAt: Date.now(),
          earlier: [{ eventIds: ["e1"], sessionId: "s-other001", receivedAt: CUTOFF + 1000, text: "Let me check.", answering: "unprompted" }],
          draftAnswering: "unprompted",
          earlierMaxTokens: 1500,
        },
        { rerun: true },
      ),
  });
  assert.equal(verdict.late, false);
  assert.deepEqual(verdict.revise.map((f) => f.code), ["style_q"], "the in-hand style verdict is kept");
  storage.close();
});

/** A DM session (carol, privately) that cross-posted into the room. */
async function dmCrossPost(storage: Storage, body: string, receivedAt: number) {
  await storage.insertAgentSession({
    id: "s-dmcarol", timelineKey: DM, sessionType: "default", status: "running", createdAt: 1, updatedAt: 1,
    triggerEventId: "t-dm", triggerBody: "PRIVATE: tell the room the meeting moved, my hearing is at 3",
    triggerSenderId: "@carol:example.org", triggerSenderDisplayName: "carol",
  } as never);
  await botMessage(storage, "e-x", body, receivedAt, "s-dmcarol", OWN);
}

test("visibility: what another session was answering in an isolated DM is never shown, in the state or the error", async () => {
  const storage = await newStorage();
  await dmCrossPost(storage, "Heads up: the meeting moved to 4.", CUTOFF + 1000);
  const t = await setup({ storage, visibility: { dms: "isolated" }, answer: (q) => (q === "contradicts" ? 0.95 : 0.1) });
  const error = await t.call({ message: "The meeting is at 3." });
  assert.match(error, /^Not sent/);
  assert.ok(!error.includes("hearing") && !error.includes("carol"), error);
  assert.match(error, /another conversation you cannot see from here/);
  assert.ok(!error.includes("in this room in parallel"), "the earlier session was not in this room");
  const [earlier] = t.decisions[0]!.state.earlier;
  assert.equal(earlier.answering, "not visible from this conversation");
  assert.equal(earlier.text, "Heads up: the meeting moved to 4.", "the message itself is in the room");
  storage.close();
});

test("visibility: without isolation the DM's request is shown, naming where it was", async () => {
  const storage = await newStorage();
  await dmCrossPost(storage, "Heads up: the meeting moved to 4.", CUTOFF + 1000);
  const t = await setup({ storage, visibility: {}, answer: (q) => (q === "contradicts" ? 0.95 : 0.1) });
  const error = await t.call({ message: "The meeting is at 3." });
  assert.match(error, new RegExp(`you, answering a message in ${DM.replace(/[$!.]/g, "\\$&")} in parallel`));
  assert.match(error, /it was answering carol in /);
  assert.deepEqual(t.decisions[0]!.state.earlier[0].answering, { from: "carol", text: "PRIVATE: tell the room the meeting moved, my hearing is at 3" });
  storage.close();
});

test("visibility: a send into an isolated channel the session is not in reads none of its messages", async () => {
  const storage = await newStorage();
  await botMessage(storage, "e-iso", "Over there: 42.", CUTOFF + 1000, "s-other001", OTHER);
  const t = await setup({
    storage,
    visibility: { channels: [{ timeline_key: OTHER, mode: "isolated" }] },
    answer: () => 0.95,
  });
  assert.equal(await t.call({ message: "42", channel: OTHER, context_note: "n" }, "send_to_channel"), "sent");
  assert.equal(t.decisions.length, 0);
  assert.equal(skipped(t.lines).at(-1), "no_unseen");
  storage.close();
});

test("an edit of an older own message is not judged as a new post against a later message", async () => {
  const storage = await newStorage();
  await botMessage(storage, "e-mine", "Its 42.", CUTOFF - 10, SELF);
  await botMessage(storage, "e-later", "It's 42, yes.", CUTOFF + 1000);
  const t = await setup({ storage, answer: (q) => (q === "repeats" ? 0.95 : 0.1) });
  assert.equal(await t.call({ message_id: "$mine", text: "It's 42." }, "edit_message"), "sent");
  assert.equal(t.decisions.length, 0);
  // A new post with the same text is still judged.
  assert.match(await t.call({ message: "It's 42." }), /^Not sent/);
  storage.close();
});
