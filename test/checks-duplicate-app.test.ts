/**
 * App-level duplicate-send check (ARCHITECTURE.md §8j "Duplicate sends"): two
 * parallel sessions of one agent answer the same question; the second, built
 * before the first one sent, drafts what the first already said. Its send is
 * blocked once with the duplicate error, and its rewrite goes out.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { startHarness, type AppHarness } from "./helpers/app-harness.js";
import { isRecordTurnRequest, messageText, type FakeLlmReply, type FakeLlmRequest } from "./helpers/fake-llm.js";

const CONFIG = `
[agent.sessions]
max_concurrent = 2

[models.decider]
id = "decider-1"
provider = "fake"
api = "system-one"
endpoint = "LLM_URL/decisions"
api_key = "k"
input_modalities = ["text"]
max_tokens = 1
context_window = 32000

[decisions]
enabled = true
model = "decider"

[decisions.checks]
enabled = true

[checks.duplicate]
enabled = true
`;

const send = (message: string): FakeLlmReply => ({
  toolCalls: [{ name: "send_message", args: { message, is_reply: false, final: true } }],
});

/** Who triggered the request's session: the sender of its trigger turn's message. */
function triggeredBy(req: FakeLlmRequest): string | undefined {
  const turn = messageText(req.body.messages.filter((m) => m.role === "user").at(-1));
  return [...turn.matchAll(/<message sender="([^"]+)"/g)].at(-1)?.[1];
}

function toolResults(req: FakeLlmRequest): string[] {
  return req.body.messages.filter((m) => m.role === "tool").map((m) => messageText(m));
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("app: two parallel sessions of one agent; the second's repeat is blocked once, then its rewrite is sent", async () => {
  let h!: AppHarness;
  let bobRequested = false;
  const storedBotMessages = () =>
    h.query<{ n: number }>("select count(*) as n from timeline_events where role = 'assistant' and agent_session_id is not null")[0]!.n;
  h = await startHarness({
    toml: CONFIG,
    // Only the duplicate call says yes (to all three questions), and only to the repeat;
    // the built-in refusal checks say no.
    decideNoul: (body) => {
      const ids = Object.keys(body.questions);
      if (!ids.some((id) => id.startsWith("duplicate__"))) return 0.02;
      const state = body.state as { draft?: { text?: string } };
      return state.draft?.text === "The answer is 42." ? 0.93 : 0.05;
    },
    script: async (req) => {
      if (isRecordTurnRequest(req)) return { text: "NO_REPLY" };
      if (triggeredBy(req) === "alice") {
        // Alice's session sends only after Bob's session was built (its first request).
        await waitFor(() => bobRequested, "bob's session built");
        return send("It's 42.");
      }
      if (toolResults(req).some((r) => r.includes("Not sent. Another session of yours"))) {
        return send("As my other reply here said: 42.");
      }
      bobRequested = true;
      // Bob's session drafts after Alice's answer is out, without having seen it.
      await waitFor(() => storedBotMessages() >= 1, "alice's answer stored");
      return send("The answer is 42.");
    },
  });
  try {
    h.say("hey bot what is 6*7", { mention: true });
    h.say("hey bot, six times seven?", { mention: true, sender: { id: "@bob:fake", displayName: "Bob", username: "bob" } });
    await h.until(() => h.sends.length >= 2, "both sessions answered");
    await h.until(
      () => {
        const rows = h.query<{ status: string }>("select status from agent_sessions");
        return rows.length === 2 && rows.every((r) => r.status === "completed");
      },
      "both sessions completed",
    );
    assert.deepEqual(
      h.sends.map((s) => s.msg.text ?? (s.msg as { body?: string }).body),
      ["It's 42.", "As my other reply here said: 42."],
      "the repeat was never sent",
    );

    // One duplicate decision call: Bob's first draft against Alice's answer.
    const duplicateCalls = h.llm.decisions.filter((d) => Object.keys(d.questions).some((id) => id.startsWith("duplicate__")));
    assert.equal(duplicateCalls.length, 1, "the rewrite was compared with nothing new: no call");
    const state = duplicateCalls[0]!.state as { earlier: Array<{ text: string; answering: unknown; seconds_before_draft: number }>; draft: { text: string; answering: unknown } };
    assert.deepEqual(state.earlier.map((m) => [m.text, m.answering]), [["It's 42.", { from: "Alice", text: "hey bot what is 6*7" }]]);
    assert.deepEqual(state.draft, { answering: { from: "Bob", text: "hey bot, six times seven?" }, text: "The answer is 42." });

    // Bob's session: the blocked call is in its transcript with the error, and its rows record the rejection.
    const [bob] = h.query<{ id: string }>("select id from agent_sessions where trigger_sender_id = '@bob:fake'");
    const rows = h.query<{ consequence: string; verdict_json: string }>(
      "select consequence, verdict_json from decision_evaluations where agent_session_id = ? and point = 'checks' and questions_json like '%duplicate__%'",
      bob!.id,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.consequence, "revise");
    assert.deepEqual(JSON.parse(rows[0]!.verdict_json).fired, ["duplicate"]);
    const [payload] = h.query<{ transcript_json: string }>("select transcript_json from agent_session_payloads where session_id = ?", bob!.id);
    const transcript = JSON.parse(payload!.transcript_json) as Array<Record<string, any>>;
    assert.ok(typeof transcript[0]!.seen?.upTo === "number", "the build's cutoff rides on the transcript head");
    const blocked = transcript.find((m) => m.role === "toolResult" && m.isError);
    assert.match(
      blocked!.content[0].text,
      /^Not sent\. Another session of yours \(you, answering a different message in this room in parallel\) already posted a message here \d+ s ago that you have not seen: «It's 42\.» \(it was answering Alice: «hey bot what is 6\*7»\)\. Your draft answers the same question it already answered, repeats what that message already says and contradicts it\./,
    );
  } finally {
    await h.stop();
  }
});
