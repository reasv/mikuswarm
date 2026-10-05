/**
 * Built-in send-contract and ending checks (spec REFUSAL-HANDLING §5.4, §7):
 * `no_reply_intent`, `no_reply_contradiction` and the send-contract diagnostics.
 *
 * Both checks judge an ending without a send (the `no_reply` call or the
 * literal `NO_REPLY` text, not forced-completion exhaustion) and run only with
 * judged checks on (`[decisions.checks].enabled`).
 */
import type { CheckDefinition } from "../types.js";

/** The actions both checks judge: the `no_reply` tool and the `NO_REPLY` text marker. */
const NO_REPLY_ACTIONS = ["no_reply", "NO_REPLY"];

/** `no_reply_intent` answers (spec §7.4). */
export const NO_REPLY_INTENT_OPTIONS = {
  intended_no_reply:
    "It meant not to reply: `first_attempt` is reasoning or a note concluding that no reply is needed, and it ended the same way.",
  abandoned_written_reply:
    "`first_attempt` contains a reply written for the users, and it ended without sending that reply.",
  unclear: "The texts do not show which of the two happened.",
} as const;

export const BUILTIN_CONTRACT_CHECKS: readonly CheckDefinition[] = [
  {
    // §7.4: after a forced-completion nudge, did `no_reply` end the turn as
    // intended, or to give up on a reply written as plain text? Observe only.
    code: "no_reply_intent",
    kind: "contract",
    enabled: true,
    remedy: "observe",
    description: "After a forced-completion nudge: no_reply as intended, or abandoning a reply written as text",
    checkpoints: ["ending"],
    apiSignals: [],
    patterns: [],
    words: [],
    questions: [
      {
        source: "text",
        type: "choice",
        instructions:
          "In this turn the assistant first wrote `first_attempt` without sending it to the chat, was then reminded " +
          "(`nudges` times) that it had not sent a message, and finally ended without sending anything. `analysis`, " +
          "`text` and `thinking` are what it wrote around that final decision. Why did it end without sending?",
        criteria: {
          true: NO_REPLY_INTENT_OPTIONS.abandoned_written_reply,
          false: NO_REPLY_INTENT_OPTIONS.intended_no_reply,
        },
        options: { ...NO_REPLY_INTENT_OPTIONS },
        fireOption: "abandoned_written_reply",
        threshold: 0.6,
        afterNudge: true,
        actions: NO_REPLY_ACTIONS,
      },
    ],
    builtin: true,
  },
  {
    // §5.4: the reasoning concludes it should reply, or a reply was written but
    // never sent. Revise remedy (the tool error and override are phase 5).
    code: "no_reply_contradiction",
    kind: "contract",
    enabled: false,
    remedy: "revise",
    description:
      "Ends without a reply although its reasoning concluded it should reply, or after writing a reply it never sent",
    agentExplanation:
      "Your reasoning concluded you should reply, or you wrote a reply without sending it. Send it with send_message, " +
      "or call no_reply again with override `no_reply_contradiction` if not replying is intended.",
    checkpoints: ["ending"],
    apiSignals: [],
    patterns: [],
    words: [],
    questions: [
      {
        source: "analysis",
        instructions:
          "`analysis` is the assistant's note written right before it ended its turn without sending a chat message " +
          "(`action`). `analysis` concludes that the assistant should reply to the chat, or contains a reply meant for the users.",
        criteria: {
          true: "`analysis` says a reply should be sent, or holds a reply written for the users.",
          false:
            "`analysis` concludes that no reply is needed (not addressed to it, already answered, nothing to add), " +
            "or only plans other work.",
        },
        threshold: 0.8,
        actions: NO_REPLY_ACTIONS,
      },
      {
        source: "text",
        instructions:
          "`text` is what the assistant wrote outside its chat messages (users never see it) before it ended its turn " +
          "without sending a chat message (`action`). `text` is a reply meant for the users, or concludes that the " +
          "assistant should reply.",
        criteria: {
          true: "`text` is a reply written for the users, or says a reply should be sent.",
          false:
            "`text` is reasoning or a note concluding that no reply is needed (not addressed to it, already answered, " +
            "nothing to add).",
        },
        threshold: 0.85,
        actions: NO_REPLY_ACTIONS,
      },
      {
        source: "thinking",
        instructions:
          "`thinking` is the end of the assistant's private reasoning before it ended its turn without sending a chat " +
          "message (`action`). The reasoning ends by concluding that the assistant should reply to the chat.",
        criteria: {
          true: "`thinking` ends by deciding to reply.",
          false: "`thinking` considers replying and then decides no reply is needed, or never considers replying.",
        },
        threshold: 0.9,
        actions: NO_REPLY_ACTIONS,
      },
    ],
    builtin: true,
  },
];
