# Explicit Send — System Prompt Design (Future Work)

This document captures the context and requirements for updating the agent's system prompt to support the explicit send contract. The actual prompt text will be defined in a future session.

---

## What changed and why this matters

The runner no longer implicitly delivers assistant text blocks to chat. All message delivery now goes through the `send_message` tool. The agent must learn this contract through its system prompt — without clear prompting, it will produce bare text expecting the runner to forward it, and users will see silence.

### Pain points the prompt must address

1. **LLMs default to text output.** Every foundation model is trained to produce text responses. Without explicit instruction, the agent will write its answer as a text block and assume it was delivered. The prompt must override this default behavior clearly and early.

2. **Thinking contamination.** The previous implicit path required regex stripping of reasoning/thinking tags that leaked into content blocks. The new contract sidesteps this entirely — text blocks are scratchpad. But the agent needs to understand this or it will try to "clean up" its text output instead of using the tool.

3. **NO_REPLY ambiguity.** The agent must understand when and how to use `NO_REPLY`. Without clear guidance, it may:
   - Produce `NO_REPLY` when it should respond (over-silencing).
   - Produce text instead of `NO_REPLY` when it has nothing to say (triggering force-continuation loops).
   - Use variant formats (`{"action":"NO_REPLY"}`, `no_reply`, `No Reply`) that don't match the literal check.

4. **Multi-step flows.** The agent needs to understand the pattern: acknowledge early via `send_message`, do work (tool calls), then either send results via another `send_message` or `NO_REPLY` if the acknowledgement was sufficient. Without this, the agent will try to do all work first and then produce a text summary that goes nowhere.

5. **Terminal condition enforcement.** The agent gets force-continued if it ends a turn without `send_message` or `NO_REPLY`. The prompt should explain this so the agent self-corrects rather than requiring retries. Force-continuation burns tokens and adds latency.

6. **Scratchpad vs. delivery.** Text blocks are now explicitly scratchpad. The agent may try to use them for visible commentary, status updates, or partial responses. The prompt must make the boundary unambiguous: text = internal, `send_message` = external.

### What the prompt must ensure

- The agent understands that text output is never seen by users.
- The agent knows `send_message` is the only way to deliver messages.
- The agent knows `NO_REPLY` (exact literal, as text output) is the only way to signal intentional silence.
- The agent understands that every turn must end with one of these two outcomes.
- The agent knows what happens if it violates the contract (force-continuation, then eventual discard).
- The agent understands multi-message flows (early ack + later result).
- The prompt is positioned with high enough priority that it isn't overridden by tool descriptions or other instructions.

### Critical: the framework's turn model and `terminate`

The pi-agent-core framework normally prompts the model for another assistant turn after tool execution. Without intervention, every `send_message` call would waste a full LLM turn on a pointless follow-up.

**Solution implemented:** `send_message` returns `terminate: true` (via the `final` parameter, default true). This stops the agent loop immediately after tool execution. The common case — a simple one-message reply — is a single LLM turn with no overhead.

**The `final` parameter:**
- `final: true` (default): agent loop terminates after this send. Use for the last message of a turn.
- `final: false`: agent loop continues. Use for early acknowledgements before doing more work.

**Remaining infinite loop risk with `final: false`:** if the agent calls `send_message` with `final: false`, does work, and then produces non-NO_REPLY text without a subsequent (final) `send_message`, force-continuation fires. The agent then might call `send_message` again with `final: true` (correct) or `final: false` (loop continues, potentially repeating). The force-continuation prompt must guide the agent toward the correct exit.

### Turn model summary for prompting

The prompt must teach:
- **Simple reply:** call `send_message` (final defaults to true) → turn ends immediately.
- **Multi-step:** call `send_message` with `final: false` → do work → call `send_message` (final true) → turn ends.
- **Silence:** output `NO_REPLY` as text → turn ends (terminal condition satisfied without any send).

The agent does NOT need to output `NO_REPLY` after a final send — the loop terminates on the tool call itself.

### Force-continuation prompt should be context-aware

Force-continuation fires when the agent produces non-`NO_REPLY` text after a `final: false` send (or after no send at all). The prompt should differentiate:

- **Agent hasn't sent anything yet:** "Call send_message with your response. Or output NO_REPLY if you have nothing to say."
- **Agent already sent via tool (non-final):** "You already sent a message. Either call send_message again with your follow-up, or output NO_REPLY if you're done."

This prevents the agent from calling `send_message` with `final: false` in an infinite loop.

### Considerations for prompt design

- **Placement**: this instruction must come before tool descriptions so the agent internalizes the contract before seeing the tool schema. If it sees `send_message` as "just another tool" before understanding the delivery model, it may treat it as optional.
- **Repetition**: the key rule ("text is not visible, use send_message") should appear at least twice — once in the messaging rules section and once in the tool description for `send_message`.
- **Examples**: concrete examples of correct turn flows:
  - Simple reply: call `send_message` (final: true, the default) → turn ends immediately (1 LLM turn total)
  - Multi-step: call `send_message` with `final: false` (ack) → do tool work → call `send_message` (final: true, results) → turn ends
  - Intentional silence: output `NO_REPLY` as text (no `send_message` call)
- **Negative examples** (critical — these cause infinite loops or wasted retries):
  - Producing a bare text response (never delivered, triggers force-continuation)
  - Calling `send_message` with `final: false` and then producing text without a final send (triggers force-continuation)
  - Calling `send_message` with `final: false` repeatedly without ever using `final: true` (infinite loop until retries exhaust)
- **Force-continuation awareness**: the agent should know that if it messes up, it gets a second chance with a corrective prompt. This reduces the cost of failure but doesn't eliminate it.
- **Two ways to end a turn:** (1) `send_message` with `final: true` terminates the loop on the tool call, or (2) `NO_REPLY` text output for silence. The agent does NOT need `NO_REPLY` after a final send.

---

## Current state

**Done.** The workspace-driven prompt system is implemented and the explicit send contract is fully covered in the agent's prompts:

- **AGENTS.md** (system prompt): "Turn Model (Critical)" section explains the explicit send contract, `final` parameter, `NO_REPLY`, and the text-is-scratchpad rule as the first major section.
- **TAIL.md** (satellite block): "Send Contract Reminder" repeats the core rules near the end of context, reinforcing the contract right before the agent acts.
- **Force-continuation prompt**: handled by the runner (unchanged).

The contract is taught twice — once in the system prompt (high priority, early) and once in the tail (recency bias, near the trigger). This matches the design requirements from this document.
