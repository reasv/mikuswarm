import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRunner } from "../src/agent/runner.js";
import type { AgentSessionRecord } from "../src/agent/session-manager.js";

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
