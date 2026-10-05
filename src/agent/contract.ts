/**
 * Send-contract mechanics (spec REFUSAL-HANDLING §7.1–§7.2, DECISION-MODEL §5.8).
 *
 * The runner's forced-completion prompts live here as constants, together with
 * every wording they ever had, so live sessions and history are read by the same
 * pure function: {@link deriveContractEvents} turns a transcript (plus the
 * session's discarded branches) into per-attempt rows and a per-session outcome.
 * Only mechanical failure types are produced here; `self_talk` needs a decision
 * model (the offline audit worker).
 */

import type { ContractOutcome } from "../storage/database.js";
import { RENDERED_MESSAGE_TAGS } from "../context/renderer.js";
import {
  IRREVERSIBLE_TOOLS,
  POSTING_TOOL_NAMES,
  REDO_SAFE_TOOL_NAMES,
  isPostingTool,
} from "../tools/side-effects.js";

/**
 * Bump when the derivation changes in a way that alters stored rows: the startup
 * reconciliation re-derives every session stamped with a lower version.
 */
export const CONTRACT_DERIVATION_VERSION = 1;

export type NudgeVariant = "not_sent" | "sent_not_final";
export type AttemptVariant = "original" | NudgeVariant;

/**
 * The forced-completion corrective prompts (ARCHITECTURE.md §8 "Forced
 * completion"). `current` is what the runner sends; `historical` lists every
 * earlier wording (from the git history of the runner), so transcripts written
 * before the prompts were tagged are still recognized.
 */
export const FORCED_COMPLETION_PROMPTS: {
  readonly current: Readonly<Record<NudgeVariant, string>>;
  readonly historical: readonly { readonly variant: NudgeVariant; readonly text: string }[];
} = {
  current: {
    not_sent:
      "Your turn ended without sending a message. You must end every turn by either:\n" +
      "- Calling send_message with your response, OR\n" +
      "- Calling no_reply if you have nothing to say.\n\n" +
      "Text you write outside of send_message is not visible to users.",
    sent_not_final:
      "You already sent a message but your turn did not end cleanly. Either:\n" +
      "- Call send_message again with your follow-up and final=true to end your turn, OR\n" +
      "- Call no_reply if you have nothing more to say.\n\n" +
      "Text you write outside of send_message is not visible to users.",
  },
  historical: [
    // Before the explicit send contract (one prompt, no prior-send variant).
    {
      variant: "not_sent",
      text: "Your previous turn ended without visible text. Produce the final chat response now, or exactly NO_REPLY.",
    },
    // Explicit send contract, NO_REPLY as text.
    {
      variant: "not_sent",
      text:
        "Your turn ended without sending a message. You must end every turn by either:\n" +
        "- Calling send_message with your response, OR\n" +
        "- Outputting exactly NO_REPLY if you have nothing to say.\n\n" +
        "Text you write outside of send_message is not visible to users.",
    },
    // Prior-send variant while `final` defaulted to true.
    {
      variant: "sent_not_final",
      text:
        "You already sent a message but your turn did not end cleanly. Either:\n" +
        "- Call send_message again with your follow-up (it will end your turn by default), OR\n" +
        "- Output exactly NO_REPLY if you have nothing more to say.\n\n" +
        "Text you write outside of send_message is not visible to users.",
    },
    // Prior-send variant once `final` became required, NO_REPLY still as text.
    {
      variant: "sent_not_final",
      text:
        "You already sent a message but your turn did not end cleanly. Either:\n" +
        "- Call send_message again with your follow-up and final=true to end your turn, OR\n" +
        "- Output exactly NO_REPLY if you have nothing more to say.\n\n" +
        "Text you write outside of send_message is not visible to users.",
    },
  ],
};

/** The harness marker stamped on a corrective user turn (spec §7.1). */
export interface ForcedCompletionMarker {
  kind: "forced_completion";
  /** The nudge number n: the ending that follows is attempt n. */
  attempt: number;
  variant: NudgeVariant;
}

/**
 * The §7.2 failure types, in precedence order (the first present is the primary
 * type). `self_talk` is judged offline and never produced by this module.
 */
export const CONTRACT_FAILURE_TYPES = [
  "invalid_tool_call",
  "textual_tool_call",
  "context_mimicry",
  "sent_not_final",
  "self_talk",
  "text_only",
  "empty",
] as const;
export type ContractFailureType = (typeof CONTRACT_FAILURE_TYPES)[number];

/** The primary type of a failed attempt, by {@link CONTRACT_FAILURE_TYPES} precedence. */
export function primaryContractFailure(types: readonly string[]): ContractFailureType | null {
  for (const type of CONTRACT_FAILURE_TYPES) if (types.includes(type)) return type;
  return null;
}

/**
 * The variant of a corrective prompt text, or undefined when the text is not
 * one (current or historical; whitespace-insensitive at the ends).
 */
export function matchForcedCompletionPrompt(text: string): NudgeVariant | undefined {
  const t = text.trim();
  if (t === FORCED_COMPLETION_PROMPTS.current.not_sent) return "not_sent";
  if (t === FORCED_COMPLETION_PROMPTS.current.sent_not_final) return "sent_not_final";
  for (const h of FORCED_COMPLETION_PROMPTS.historical) if (t === h.text) return h.variant;
  return undefined;
}

// ---------------------------------------------------------------------------
// Served-model attribution
// ---------------------------------------------------------------------------

/**
 * Stamp the logical model (config entry) that served a committed assistant
 * message onto it, as a plain persisted field. pi ignores unknown fields; the
 * transcript keeps it, so attempts attribute to the member that actually served
 * them (fallback can change it between attempts).
 */
export function stampServedModel(message: unknown, logicalId: string): void {
  if (message && typeof message === "object") {
    (message as { served?: { logicalId: string } }).served = { logicalId };
  }
}

/** The stamped serving logical model of an assistant message, if any. */
export function servedModelOf(message: unknown): string | undefined {
  const served = (message as { served?: { logicalId?: unknown } } | undefined)?.served;
  return typeof served?.logicalId === "string" ? served.logicalId : undefined;
}

// ---------------------------------------------------------------------------
// Mechanical text patterns (§7.2)
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every tool name the harness knows (the side-effect lists cover all of them). */
export const KNOWN_TOOL_NAMES: readonly string[] = [
  ...new Set([...POSTING_TOOL_NAMES, ...REDO_SAFE_TOOL_NAMES, ...IRREVERSIBLE_TOOLS]),
];

/** Tool-call markup of the common chat templates and tool-call formats, written as text. */
const TOOL_CALL_MARKUP_PATTERNS: readonly RegExp[] = [
  /<\/?(?:[a-z]+:)?(?:tool_calls?|function_calls?|invoke|tool_use)\b/i,
  /<function=/i,
  /<\|(?:tool_call|tool_calls|python_tag)[^>]*\|?>/i,
  /<｜tool[▁_]call/i,
  /\[TOOL_CALLS\]/,
  /\bto=functions\./,
  /"(?:tool_calls|function_call|tool_use)"\s*:/,
];

function toolNamePatterns(names: readonly string[]): RegExp[] {
  if (names.length === 0) return [];
  const alt = names.map(escapeRegExp).join("|");
  return [
    // function-call syntax with an argument: send_message({...}) / send_message(text="…")
    new RegExp(`\\b(?:functions\\.)?(?:${alt})\\s*\\(\\s*(?:\\{|"|'|\\w+\\s*[=:])`),
    // JSON naming the tool: {"name": "send_message", …}
    new RegExp(`"(?:name|tool|tool_name|function|recipient_name)"\\s*:\\s*"(?:functions\\.)?(?:${alt})"`),
    // the tool's name followed by an argument object: send_message {"text": …}
    new RegExp(`\\b(?:${alt})\\b\\s*:?\\s*\\{\\s*"`),
  ];
}

function contextTagPattern(tags: readonly string[]): RegExp {
  const alt = tags.map(escapeRegExp).join("|");
  return new RegExp(`</?(?:${alt})(?=[\\s>/])`);
}

/** Tags the detector treats as context markup: the renderer's, plus the interjection wrapper. */
const CONTEXT_MIMICRY_TAGS: readonly string[] = [...RENDERED_MESSAGE_TAGS, "interjection"];

const DEFAULT_TOOL_NAME_PATTERNS = toolNamePatterns(KNOWN_TOOL_NAMES);
const CONTEXT_MIMICRY_PATTERN = contextTagPattern(CONTEXT_MIMICRY_TAGS);

/** Text that tries to call a tool but was written as text (§7.2 `textual_tool_call`). */
export function looksLikeTextualToolCall(text: string, toolNames?: readonly string[]): boolean {
  const named = toolNames ? toolNamePatterns(toolNames) : DEFAULT_TOOL_NAME_PATTERNS;
  return TOOL_CALL_MARKUP_PATTERNS.some((re) => re.test(text)) || named.some((re) => re.test(text));
}

/** Text reproducing the context's rich-message markup (§7.2 `context_mimicry`). */
export function looksLikeContextMimicry(text: string): boolean {
  return CONTEXT_MIMICRY_PATTERN.test(text);
}

// ---------------------------------------------------------------------------
// Message shape helpers (structural: transcripts are parsed JSON)
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;
interface Block {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

function asObj(m: unknown): Loose | undefined {
  return m !== null && typeof m === "object" ? (m as Loose) : undefined;
}

function harnessKind(m: Loose): string | undefined {
  const h = asObj(m["harness"]);
  return typeof h?.["kind"] === "string" ? (h["kind"] as string) : undefined;
}

function blocksOf(m: Loose): Block[] {
  return Array.isArray(m["content"]) ? (m["content"] as Block[]).filter((b) => b && typeof b === "object") : [];
}

function contentText(m: Loose): string {
  const c = m["content"];
  if (typeof c === "string") return c;
  return blocksOf(m)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

function toolCallsOf(m: Loose): { id: string; name: string; args: unknown }[] {
  return blocksOf(m)
    .filter((b) => b.type === "toolCall" && typeof b.name === "string")
    .map((b) => ({ id: typeof b.id === "string" ? b.id : "", name: b.name as string, args: b.arguments }));
}

/** A corrective prompt: tagged, or (history) matching a known wording. */
export function nudgeOf(message: unknown): { variant: NudgeVariant; attempt?: number } | undefined {
  const m = asObj(message);
  if (!m || m["role"] !== "user") return undefined;
  const h = asObj(m["harness"]);
  if (h?.["kind"] === "forced_completion") {
    const variant = h["variant"] === "sent_not_final" ? "sent_not_final" : "not_sent";
    const attempt = typeof h["attempt"] === "number" ? (h["attempt"] as number) : undefined;
    return { variant, attempt };
  }
  if (h) return undefined;
  const variant = matchForcedCompletionPrompt(contentText(m));
  return variant ? { variant } : undefined;
}

/**
 * True for a message that starts a run: the frozen final user turn of a fresh or
 * resumed run (`triggerGroup`, `satellite`), or a plain user turn that is not a
 * harness turn or a corrective prompt.
 */
export function isRunStart(message: unknown): boolean {
  const m = asObj(message);
  if (!m) return false;
  if (m["type"] === "triggerGroup" || m["type"] === "satellite") return true;
  if (m["role"] !== "user") return false;
  if (m["harness"] !== undefined) return false;
  return nudgeOf(m) === undefined;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** A discarded branch as the derivation needs it (from `agent_session_branches`). */
export interface ContractBranchInput {
  branchNo: number;
  forkIndex: number;
  reason: string;
  messages: unknown[];
}

/** One derived send-contract attempt (§7.1); maps onto a `contract_attempts` row. */
export interface DerivedContractAttempt {
  /** 0 = the attempt's ending is in the live transcript; n = in discarded branch n. */
  branchNo: number;
  /** Number of send-contract redos before this attempt. */
  redoNo: number;
  /** 0 = the original ending, n = the ending after nudge n (renumbered on collisions, see below). */
  attemptNo: number;
  ts: number | null;
  /** Stamped serving logical model; null for history (use `wireModel`). */
  servedModel: string | null;
  wireModel: string | null;
  variant: AttemptVariant;
  /** §7.2 types, precedence order; [] = a valid ending. */
  failureTypes: ContractFailureType[];
  primaryType: ContractFailureType | null;
}

export interface ContractDerivation {
  attempts: DerivedContractAttempt[];
  /** Null when no run reached a send-contract verdict (no ending, or it was aborted/failed). */
  outcome: ContractOutcome | null;
  /** Corrective prompts sent, discarded branches included. */
  nudges: number;
  /** Send-contract redos (`contract_redo` branches). */
  redos: number;
}

export interface DeriveContractOptions {
  /** The session's discarded branches; omitted = none (all history). */
  branches?: readonly ContractBranchInput[];
  /** Tool names for the `textual_tool_call` name patterns; default {@link KNOWN_TOOL_NAMES}. */
  toolNames?: readonly string[];
}

interface Located {
  m: unknown;
  /** Final location: 0 = live transcript, n = discarded branch n. */
  loc: number;
}

type ChronItem = { kind: "message"; m: unknown; loc: number } | { kind: "fork"; reason: string; branchNo: number };

/**
 * Rebuild the order in which messages were produced from the live transcript
 * and its discarded branches. Fork k truncated the live list at `forkIndex` and
 * stored the discarded tail as branch k, so the list before fork k is the list
 * after it cut at `forkIndex` plus branch k's messages; walking the branches
 * newest-first recovers every earlier list, and each message keeps the branch
 * it finally landed in.
 */
function chronology(transcript: readonly unknown[], branches: readonly ContractBranchInput[]): ChronItem[] {
  const sorted = [...branches].sort((a, b) => a.branchNo - b.branchNo);
  let cur: Located[] = transcript.map((m) => ({ m, loc: 0 }));
  const steps: { branch: ContractBranchInput; after: Located[] }[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const b = sorted[i]!;
    const f = Math.max(0, Math.min(b.forkIndex, cur.length));
    steps.unshift({ branch: b, after: cur.slice(f) });
    cur = cur.slice(0, f).concat(b.messages.map((m) => ({ m, loc: b.branchNo })));
  }
  const out: ChronItem[] = cur.map((x) => ({ kind: "message", m: x.m, loc: x.loc }));
  for (const step of steps) {
    out.push({ kind: "fork", reason: step.branch.reason, branchNo: step.branch.branchNo });
    for (const x of step.after) out.push({ kind: "message", m: x.m, loc: x.loc });
  }
  return out;
}

interface InternalAttempt extends DerivedContractAttempt {
  /** A valid ending that was a silent `no_reply` / `NO_REPLY`. */
  silent: boolean;
}

interface RunState {
  attempts: InternalAttempt[];
  /** Messages since the last attempt boundary. */
  span: Located[];
  natural: number;
  variant: AttemptVariant;
  nudges: number;
  contractRedos: number;
  /** The last closed span ended aborted/failed, with no complete attempt after it. */
  incompleteEnd: boolean;
  /** A posting tool call delivered (non-error result) during the run. */
  delivered: boolean;
  /** Posting tool call ids seen in the run, to match their results. */
  postingCalls: Set<string>;
}

function newRun(): RunState {
  return {
    attempts: [],
    span: [],
    natural: 0,
    variant: "original",
    nudges: 0,
    contractRedos: 0,
    incompleteEnd: false,
    delivered: false,
    postingCalls: new Set(),
  };
}

function isValidEnding(ending: Loose): boolean {
  if (contentText(ending).trim() === "NO_REPLY") return true;
  return toolCallsOf(ending).some((c) => c.name === "send_message" || c.name === "no_reply");
}

function isSilentEnding(ending: Loose): boolean {
  if (contentText(ending).trim() === "NO_REPLY") return true;
  const calls = toolCallsOf(ending);
  return calls.some((c) => c.name === "no_reply") && !calls.some((c) => c.name === "send_message");
}

/**
 * Classify the attempt spanning `span` (the messages since the previous
 * boundary). Returns undefined when the span has no ending, or "incomplete"
 * when its ending was aborted or failed (not a send-contract verdict).
 */
function closeSpan(
  span: readonly Located[],
  run: RunState,
  redoNo: number,
  textualPatterns: readonly RegExp[],
): InternalAttempt | "incomplete" | undefined {
  let ending: Located | undefined;
  for (let i = span.length - 1; i >= 0; i -= 1) {
    const m = asObj(span[i]!.m);
    if (m?.["role"] === "assistant" && harnessKind(m) === undefined) {
      ending = span[i];
      break;
    }
  }
  if (!ending) return undefined;
  const e = asObj(ending.m)!;
  if (e["stopReason"] === "aborted" || e["stopReason"] === "error") return "incomplete";

  // Outcomes of the attempt's contract-tool calls (posting tools, no_reply), in order.
  const resultError = new Map<string, boolean>();
  for (const x of span) {
    const m = asObj(x.m);
    if (m?.["role"] === "toolResult" && typeof m["toolCallId"] === "string") {
      resultError.set(m["toolCallId"] as string, m["isError"] === true);
    }
  }
  const sends: boolean[] = [];
  for (const x of span) {
    const m = asObj(x.m);
    if (m?.["role"] !== "assistant" || harnessKind(m) !== undefined) continue;
    for (const call of toolCallsOf(m)) {
      if (!isPostingTool(call.name) && call.name !== "no_reply") continue;
      const isError = resultError.get(call.id);
      if (isError !== undefined) sends.push(isError);
    }
  }

  const valid = isValidEnding(e);
  const types: ContractFailureType[] = [];
  if (!valid) {
    const text = contentText(e).trim();
    if (sends.length > 0 && sends[sends.length - 1] === true) types.push("invalid_tool_call");
    if (text.length > 0) {
      if (textualPatterns.some((re) => re.test(text))) types.push("textual_tool_call");
      if (looksLikeContextMimicry(text)) types.push("context_mimicry");
      types.push("text_only");
    }
    if (sends.some((isError) => !isError)) types.push("sent_not_final");
    // No text and no call; also the fallback for an ending that is invalid for
    // no other mechanical reason (e.g. only non-send calls).
    if (types.length === 0) types.push("empty");
  }
  const ordered = CONTRACT_FAILURE_TYPES.filter((t) => types.includes(t));
  return {
    branchNo: ending.loc,
    redoNo,
    attemptNo: run.natural,
    ts: typeof e["timestamp"] === "number" ? (e["timestamp"] as number) : null,
    servedModel: servedModelOf(e) ?? null,
    wireModel: typeof e["model"] === "string" ? (e["model"] as string) : null,
    variant: run.variant,
    failureTypes: ordered,
    primaryType: primaryContractFailure(ordered),
    silent: valid && isSilentEnding(e),
  };
}

const OUTCOME_SEVERITY: readonly ContractOutcome[] = [
  "clean",
  "recovered",
  "redo_recovered",
  "gave_up_no_reply",
  "exhausted",
];

function runOutcome(run: RunState): ContractOutcome | null {
  if (run.incompleteEnd) return null;
  const last = run.attempts[run.attempts.length - 1];
  if (!last) return null;
  if (last.failureTypes.length > 0) return "exhausted";
  if (run.nudges === 0 && run.contractRedos === 0) return "clean";
  // A silent ending after nudges with nothing delivered in the run: the model
  // gave up instead of recovering its message.
  if (last.silent && !run.delivered) return "gave_up_no_reply";
  return run.contractRedos > 0 ? "redo_recovered" : "recovered";
}

/**
 * Derive the send-contract events of a session from its live transcript and
 * its discarded branches (spec REFUSAL-HANDLING §7.1, DECISION-MODEL §5.8).
 * Pure: the live completion path and the history reconciliation both call it.
 *
 * - The transcript is split into **runs** (each starts at a run-start turn:
 *   the frozen final user turn of a fresh or resumed run); a record turn and
 *   everything up to the next run start is skipped.
 * - Within a run, each corrective prompt closes an **attempt** (the ending
 *   before it); the run's last ending closes the last one. Attempt n follows
 *   nudge n and carries the nudge's variant; the first ending of a run, after a
 *   contract redo, or after a refusal fork (which resets the nudge budget) is
 *   `original`.
 * - A `contract_redo` fork closes the exhausted attempt and starts the redo:
 *   later attempts carry `redoNo + 1`. Any other fork (a refusal redo) drops
 *   the ending it cut (not a send-contract verdict); messages the fork kept
 *   stay in the attempt.
 * - An ending with `stopReason` aborted/error is not an attempt.
 * - Attempt numbers are unique per (branch, redo): when two attempts collide
 *   (several runs in one transcript, a refusal fork after kept attempts), the
 *   group is renumbered 0..n-1 in production order.
 *
 * Session outcome, per run: `clean` (no nudge, valid), `recovered` (valid
 * after nudges), `redo_recovered` (valid after a contract redo),
 * `gave_up_no_reply` (a silent ending after nudges with nothing delivered in
 * the run), `exhausted` (no valid ending); the session takes its most severe
 * run, and null when no run reached a verdict.
 */
export function deriveContractEvents(
  transcript: readonly unknown[],
  opts: DeriveContractOptions = {},
): ContractDerivation {
  const textualPatterns = [
    ...TOOL_CALL_MARKUP_PATTERNS,
    ...(opts.toolNames ? toolNamePatterns(opts.toolNames) : DEFAULT_TOOL_NAME_PATTERNS),
  ];
  const items = chronology(transcript, opts.branches ?? []);
  const runs: RunState[] = [];
  let run: RunState | undefined = newRun();
  let redoNo = 0;
  let totalNudges = 0;
  let redos = 0;

  const close = (r: RunState): void => {
    const result = closeSpan(r.span, r, redoNo, textualPatterns);
    r.span = [];
    if (result === "incomplete") {
      r.incompleteEnd = true;
    } else if (result) {
      r.incompleteEnd = false;
      r.attempts.push(result);
    }
  };
  const finishRun = (): void => {
    if (!run) return;
    close(run);
    runs.push(run);
    run = undefined;
  };

  for (const item of items) {
    if (item.kind === "fork") {
      if (!run) continue;
      if (item.reason === "contract_redo") {
        close(run);
        redoNo += 1;
        redos += 1;
        run.contractRedos += 1;
      } else {
        // Keep what the fork kept; the cut ending is redone after it.
        const branchNo = item.branchNo;
        run.span = run.span.filter((x) => x.loc !== branchNo);
      }
      run.natural = 0;
      run.variant = "original";
      continue;
    }
    const m = asObj(item.m);
    if (!m) continue;
    if (m["role"] === "user" && harnessKind(m) === "record_turn") {
      finishRun();
      continue;
    }
    if (isRunStart(m)) {
      finishRun();
      run = newRun();
      run.span.push({ m: item.m, loc: item.loc });
      continue;
    }
    if (!run) continue; // inside a record turn
    const nudge = nudgeOf(m);
    if (nudge) {
      close(run);
      run.nudges += 1;
      totalNudges += 1;
      run.natural = nudge.attempt ?? run.natural + 1;
      run.variant = nudge.variant;
      continue;
    }
    if (m["role"] === "assistant" && harnessKind(m) === undefined) {
      for (const call of toolCallsOf(m)) if (isPostingTool(call.name)) run.postingCalls.add(call.id);
    } else if (m["role"] === "toolResult" && m["isError"] !== true && run.postingCalls.has(m["toolCallId"] as string)) {
      run.delivered = true;
    }
    run.span.push({ m: item.m, loc: item.loc });
  }
  finishRun();

  // Unique (branch, redo, attempt): renumber a colliding group in production order.
  const internal = runs.flatMap((r) => r.attempts);
  const groups = new Map<string, InternalAttempt[]>();
  for (const a of internal) {
    const key = `${a.branchNo}:${a.redoNo}`;
    const g = groups.get(key);
    if (g) g.push(a);
    else groups.set(key, [a]);
  }
  for (const g of groups.values()) {
    if (new Set(g.map((a) => a.attemptNo)).size !== g.length) g.forEach((a, i) => (a.attemptNo = i));
  }

  let outcome: ContractOutcome | null = null;
  for (const r of runs) {
    const o = runOutcome(r);
    if (o === null) continue;
    if (outcome === null || OUTCOME_SEVERITY.indexOf(o) > OUTCOME_SEVERITY.indexOf(outcome)) outcome = o;
  }
  const attempts = internal.map(({ silent: _silent, ...a }) => a);
  return { attempts, outcome, nudges: totalNudges, redos };
}

/**
 * The attempt the live transcript currently ends with (for the runner's
 * `contract_attempt` log line), or undefined when it has none.
 */
export function currentContractAttempt(messages: readonly unknown[]): DerivedContractAttempt | undefined {
  const derived = deriveContractEvents(messages);
  return derived.attempts[derived.attempts.length - 1];
}
