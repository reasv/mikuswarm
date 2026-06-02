import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRunner } from "../src/agent/runner.js";
import { SessionManager } from "../src/agent/session-manager.js";
import type { AgentSessionRecord } from "../src/agent/session-manager.js";
import type { InboundChatEvent } from "../src/types.js";

/**
 * A minimal `Agent` stand-in for the runner. `messages` drives the loop guards;
 * `promptCount`/`continueCount` record force-completion attempts. `onPrompt`
 * mutates `messages` to model what a run produces (e.g. an aborted turn).
 */
function fakeAgent(opts: {
  initial: any[];
  onPrompt?: (messages: any[]) => void;
}): {
  agent: any;
  promptCount: () => number;
  continueCount: () => number;
} {
  const messages = [...opts.initial];
  let prompts = 0;
  let continues = 0;
  const agent = {
    state: { messages },
    async prompt() {
      prompts += 1;
      opts.onPrompt?.(messages);
    },
    async continue() {
      continues += 1;
    },
    async waitForIdle() {},
  };
  return { agent, promptCount: () => prompts, continueCount: () => continues };
}

const session = { id: "s-test111111" } as AgentSessionRecord;
const kickoff = { role: "user", content: "hi", timestamp: 1 } as any;

test("SessionRunner does not re-prompt after an aborted run (break on stopReason)", async () => {
  // The kickoff run is aborted: pi-agent-core resolves and appends a synthetic
  // assistant message with stopReason "aborted". The force-completion loop must
  // NOT re-prompt the cancelled agent.
  const { agent, promptCount, continueCount } = fakeAgent({
    initial: [],
    onPrompt: (messages) => {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "aborted",
      });
    },
  });

  const runner = new SessionRunner();
  const result = await runner.run(agent, session, /* maxRetries */ 3, kickoff);

  assert.equal(promptCount(), 1, "only the kickoff prompt; no forced-completion re-prompt");
  assert.equal(continueCount(), 0, "agent.continue() must not run after abort");
  assert.equal(result.noReply, true, "an aborted run yields no reply");
  assert.equal(result.retries, 0);
});

function makeTrigger(): InboundChatEvent {
  return {
    provider: "test",
    timelineKey: "tl:room1",
    event: {
      id: "evt-1",
      externalId: "ext-1",
      timelineKey: "tl:room1",
      provider: "test",
      role: "user",
      sender: { id: "u1", displayName: "User" },
      body: "hello",
      timestamp: 1000,
      receivedAt: 1000,
    },
  };
}

test("SessionRunner: an interrupt across the run terminates the loop with no extra forced-completion prompt (#1/#2)", async () => {
  // Integration-style: drive run() through a real SessionManager (no storage) so
  // the runner's lifecycle is wired to interrupt(). The kickoff turn resolves
  // NORMALLY (stopReason "stop", not "aborted") but is non-terminal (bare text):
  // this models a turn that finished streaming a hair before Stop landed. An
  // operator Stop fires in the inter-turn gap (agent.signal undefined). The loop
  // must break on the session's interrupt STATE and NOT re-prompt.
  const sessions = new SessionManager();
  const record = sessions.createPlaceholder(makeTrigger(), "default");

  let prompts = 0;
  let continues = 0;
  const messages: any[] = [];
  const controller = new AbortController();
  // signal toggles: defined during a prompt, undefined once it resolves (the
  // inter-turn gap), exactly like pi-agent-core.
  let activeSignal: AbortSignal | undefined;

  const agent: any = {
    state: { messages },
    get signal() {
      return activeSignal;
    },
    async prompt() {
      prompts += 1;
      activeSignal = controller.signal;
      // Non-terminal assistant turn that resolved normally (NOT aborted).
      messages.push({ role: "assistant", content: [{ type: "text", text: "thinking out loud" }], stopReason: "stop" });
      activeSignal = undefined; // run settled → inter-turn gap
      // Operator presses Stop in the gap (signal absent, run still in progress).
      const interrupted = sessions.interrupt(record.id);
      assert.equal(interrupted, true, "interrupt must succeed in the inter-turn gap");
    },
    async continue() {
      continues += 1;
    },
    async waitForIdle() {},
    hasQueuedMessages: () => false,
    clearAllQueues() {},
    abort() {
      controller.abort();
    },
  };

  sessions.markRunning(record.id);
  sessions.attachAgent(record.id, agent);

  const runner = new SessionRunner();
  const result = await runner.run(agent, record, /* maxRetries */ 3, kickoff, sessions.runLifecycle(record.id));

  assert.equal(prompts, 1, "only the kickoff prompt; the interrupt must prevent any forced-completion re-prompt");
  assert.equal(continues, 0, "agent.continue() must not run after interrupt");
  assert.equal(result.noReply, true, "an interrupted non-terminal run yields no reply");
  // The session status set by interrupt() is the authoritative terminal state.
  assert.equal(sessions.get(record.id)?.status, "interrupted");
});

test("SessionRunner returns cleanly when the kickoff turn is already terminal", async () => {
  // A turn that ends with send_message is terminally valid — the loop never runs.
  const { agent, promptCount, continueCount } = fakeAgent({
    initial: [],
    onPrompt: (messages) => {
      messages.push({
        role: "assistant",
        content: [{ type: "toolCall", name: "send_message", args: {} }],
      });
    },
  });

  const runner = new SessionRunner();
  const result = await runner.run(agent, session, 3, kickoff);

  assert.equal(promptCount(), 1);
  assert.equal(continueCount(), 0);
  assert.equal(result.noReply, false);
});
