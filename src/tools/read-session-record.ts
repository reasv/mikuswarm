import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Storage } from "../storage/index.js";
import type { ChannelVisibilityResolver } from "../visibility/index.js";
import { estimateTokens, truncateToTokens } from "../context/tokens.js";

/**
 * Context injected by the session assembly (W6 wires the real values;
 * defaults make the tools functional and gracefully degraded until then).
 */
export interface ReadSessionRecordToolContext {
  storage: Storage;
  /** The calling session's timeline key — used for isolation checks. */
  currentTimelineKey?: string;
  /** Same resolver injected into `read_messages` (channel visibility gate). */
  visibilityResolver?: ChannelVisibilityResolver;
  /**
   * Resolve an agent name from a timeline key, for the "own sessions only"
   * filter (multi-agent). Returns null in single-agent mode (no filter).
   * Default: no filter (single-agent safe default).
   */
  resolveAgentForTimeline?: (timelineKey: string) => string | null;
  /** The calling session's resolved agent name. Null = single-agent (no filter). */
  currentAgentName?: string | null;
  /**
   * Called with a session id to check whether its record is currently being
   * written (the record turn is still running). Default: () => false.
   */
  isRecordInFlight?: (sessionId: string) => boolean;
}

// ── Shared lookup + gate ─────────────────────────────────────────────────────
//
// Every failure THROWS: pi-agent-core marks a tool result `isError` only when
// `execute` throws (a returned result is always a success on the wire). Each
// message names the exact next call that recovers (CLAUDE.md "Errors as
// backstop and UX").

/**
 * Resolve a session by id and apply the `read_messages` visibility gate plus
 * the own-agent filter. Metadata only: the transcript blob is never loaded here.
 */
function resolveReadableSession(sessionId: string, context: ReadSessionRecordToolContext) {
  const session = context.storage.getAgentSessionMeta(sessionId);
  if (!session) {
    throw new Error(
      `No session "${sessionId}". Pass the agent_session_id attribute of a bot message exactly ` +
        `as shown (<message ... agent_session_id="...">, also on <reply_to> quotes and in read_messages output).`,
    );
  }
  if (context.visibilityResolver && context.currentTimelineKey) {
    const mode = context.visibilityResolver.modeFor(session.timeline_key);
    if (
      mode === "isolated" &&
      !context.visibilityResolver.sameChannel(session.timeline_key, context.currentTimelineKey)
    ) {
      throw new Error(
        `Session "${sessionId}" belongs to an isolated channel this session is not in; ` +
          "its record and transcript are private to that channel.",
      );
    }
  }
  if (context.currentAgentName != null && context.resolveAgentForTimeline) {
    const sessionAgent = context.resolveAgentForTimeline(session.timeline_key);
    if (sessionAgent !== null && sessionAgent !== context.currentAgentName) {
      throw new Error(
        `Session "${sessionId}" was run by another agent; only your own sessions can be read.`,
      );
    }
  }
  return session;
}

function parseBuildsOn(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

// ── read_session_record ──────────────────────────────────────────────────────

export function createReadSessionRecordTool(context: ReadSessionRecordToolContext): AgentTool {
  return {
    name: "read_session_record",
    label: "Read session record",
    // Situation first (always-on definition): the moment of need is a user
    // pointing at an earlier bot message.
    description:
      "Someone asks about an earlier bot message (\"where did you get that?\", \"post the second one\", " +
      "\"what did you find?\"): pass that message's agent_session_id to get the session's record: " +
      "sources, artifacts (paths, message ids), open threads. One session per call.",
    parameters: Type.Object({
      session_id: Type.String({ description: "The agent_session_id attribute of the bot message." }),
    }),
    execute: async (_toolCallId, params) => {
      const { session_id } = params as { session_id: string };
      const session = resolveReadableSession(session_id, context);

      if (context.isRecordInFlight?.(session_id)) {
        throw new Error(
          `The record of session "${session_id}" is still being written. ` +
            `Call read_session_record(session_id: "${session_id}") again in a few seconds.`,
        );
      }

      const record = context.storage.getSessionRecord(session_id);
      if (!record) {
        const outcome = context.storage.getSessionRecordGeneration(session_id);
        const raw = `read_session_transcript(session_id: "${session_id}") (sessions skill)`;
        if (["created", "running", "resuming", "suspended", "failed-resumable"].includes(session.status)) {
          throw new Error(`No record yet for session "${session_id}": the session has not finished. Record generation is considered after completion. Use ${raw} for work already performed.`);
        }
        if (session.status === "interrupted" || session.status === "discarded") {
          throw new Error(`No record for session "${session_id}": the session was ${session.status} before normal completion, so record generation was not started. Use ${raw}.`);
        }
        if (outcome?.status === "skipped") {
          const why: Record<string, string> = {
            no_work: "the work gate found no non-exempt tool work to record; the chat messages are the available account",
            empty: "the record writer finished and explicitly chose not to save a record",
            disabled: "record generation was disabled",
            session_type: "this session type does not produce session records",
            tool_unavailable: "the record-writing tool was unavailable for this session",
          };
          throw new Error(`No record for session "${session_id}": ${why[outcome.reason ?? ""] ?? "record generation was skipped"}. This was not a relevance-gate rejection. Use ${raw} if you need its raw tool activity.`);
        }
        if (outcome?.status === "failed" || outcome?.status === "writing") {
          const why: Record<string, string> = {
            refusal: "the record writer refused", budget_blocked: "the applicable budget was exhausted",
            llm_error: "the model request failed", max_turns: "the record writer reached its turn limit",
            shutdown: "the service shut down before generation finished", not_finalized: "the writer did not finalize a record",
          };
          const reason = outcome.status === "writing" ? "the previous attempt was interrupted and no record writer is active" : why[outcome.reason ?? ""] ?? "record generation failed";
          throw new Error(`Record generation failed for session "${session_id}": ${reason}. No record is being generated now. Use ${raw}.`);
        }
        throw new Error(`No record for session "${session_id}". Its generation outcome was not recorded, so the reason is unknown. Relevance selection does not control record creation. Use ${raw}.`);
      }

      const buildsOn = parseBuildsOn(record.builds_on);
      const parts: string[] = [record.text];
      if (buildsOn.length > 0) {
        parts.push(
          `\n\nBuilds on earlier session(s): ${buildsOn.join(", ")}. ` +
            "Each has its own record; read_session_record one of them to follow the chain one hop.",
        );
      }
      parts.push(
        `\n\nRaw tool calls behind this record: read_session_transcript(session_id: "${session_id}", ` +
          "query: \"<term>\") (sessions skill).",
      );

      return {
        content: [{ type: "text", text: parts.join("") }],
        details: { session_id, tokenCount: record.token_count, buildsOn },
      };
    },
  };
}

// ── read_session_transcript ──────────────────────────────────────────────────

/** Token allowance for one call's result (its head, or the windows around query matches). */
const TRANSCRIPT_RESULT_MAX_TOKENS = 512;
/** Token allowance for one call's arguments (a file write or a heredoc can be huge). */
const TRANSCRIPT_ARGS_MAX_TOKENS = 256;
/** Total output bound of one transcript response; further calls page via `offset`. */
const TRANSCRIPT_MAX_OUTPUT_TOKENS = 4000;
/** Characters of context kept on each side of a query match inside a result. */
const MATCH_WINDOW_CHARS = 300;

type TranscriptEntry = {
  /** 1-indexed assistant turn (assistant messages with at least one tool call). */
  turn: number;
  isHarness: boolean;
  name: string;
  argsJson: string;
  /** Result text, or undefined when no toolResult message was found for the call. */
  resultText: string | undefined;
  resultIsError: boolean;
};

/** Flatten a pi transcript into one entry per tool call, in rollout order. */
function collectEntries(messages: unknown[]): { entries: TranscriptEntry[]; totalTurns: number } {
  // pi toolResult messages carry `toolCallId` at the MESSAGE level; content
  // blocks are text/image only.
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (m?.["role"] !== "toolResult" || typeof m["toolCallId"] !== "string") continue;
    const content = Array.isArray(m["content"]) ? (m["content"] as { type?: string; text?: string }[]) : [];
    results.set(m["toolCallId"], {
      text: content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n"),
      isError: m["isError"] === true,
    });
  }

  const entries: TranscriptEntry[] = [];
  let turn = 0;
  // The record turn (from its harness prompt to the next real user turn, which
  // only a resumed generation has) is left out: its product is the record
  // itself, which read_session_record returns.
  let inRecordTurn = false;
  for (const msg of messages) {
    const m = msg as { role?: string; content?: unknown; harness?: unknown };
    if (m?.role === "user") {
      inRecordTurn = (m.harness as { kind?: unknown } | undefined)?.kind === "record_turn";
      continue;
    }
    if (inRecordTurn) continue;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    const calls = (m.content as { type?: string; id?: string; name?: string; arguments?: unknown }[])
      .filter((b) => b?.type === "toolCall");
    if (calls.length === 0) continue;
    turn++;
    for (const call of calls) {
      const result = call.id ? results.get(call.id) : undefined;
      entries.push({
        turn,
        isHarness: typeof m.harness === "object" && m.harness !== null,
        name: call.name ?? "(unknown)",
        argsJson: call.arguments !== undefined ? JSON.stringify(withoutPrefillAnalysis(call.arguments)) : "",
        resultText: result?.text,
        resultIsError: result?.isError ?? false,
      });
    }
  }
  return { entries, totalTurns: turn };
}

/**
 * Drop the OpenAI-prefill `analysis` argument (ARCHITECTURE.md "Model-scoped
 * OpenAI prefill"): it is the model's forced reasoning prefix, never part of
 * what the call did, and is not replayed to the model either.
 */
function withoutPrefillAnalysis(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args) || !("analysis" in args)) return args;
  const { analysis: _analysis, ...rest } = args as Record<string, unknown>;
  return rest;
}

/** All match offsets of `needle` (already lowercased) in `haystack`. */
function matchOffsets(haystack: string, needle: string): number[] {
  const lower = haystack.toLowerCase();
  const out: number[] = [];
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
    out.push(at);
  }
  return out;
}

/**
 * A long result with query matches: windows of context around each match
 * (overlapping windows merged), as many as fit `allowance`. Honest about what
 * was left out: the count of matches not shown and how to reach them.
 */
function renderMatchWindows(text: string, needle: string, offsets: number[], allowance: number): string {
  const windows: { from: number; to: number; matches: number }[] = [];
  for (const at of offsets) {
    const from = Math.max(0, at - MATCH_WINDOW_CHARS);
    const to = Math.min(text.length, at + needle.length + MATCH_WINDOW_CHARS);
    const last = windows[windows.length - 1];
    if (last && from <= last.to) {
      last.to = Math.max(last.to, to);
      last.matches++;
    } else {
      windows.push({ from, to, matches: 1 });
    }
  }
  const parts: string[] = [];
  let used = 0;
  let shownMatches = 0;
  for (const w of windows) {
    const piece =
      `[chars ${w.from}–${w.to} of ${text.length}]\n` +
      `${w.from > 0 ? "…" : ""}${text.slice(w.from, w.to)}${w.to < text.length ? "…" : ""}`;
    const cost = estimateTokens(piece);
    if (parts.length > 0 && used + cost > allowance) break;
    parts.push(parts.length === 0 && cost > allowance ? truncateToTokens(piece, allowance) : piece);
    used += cost;
    shownMatches += w.matches;
  }
  const hidden = offsets.length - shownMatches;
  if (hidden > 0) {
    parts.push(
      `[${hidden} more match(es) in this result not shown; a longer, more specific query reaches them]`,
    );
  }
  return parts.join("\n");
}

/** One call rendered: name, clipped arguments, and its result (windows or head). */
function renderEntry(entry: TranscriptEntry, needle: string | undefined): string {
  let out = `TOOL CALL: ${entry.name}\n`;
  if (entry.argsJson) {
    const argsTokens = estimateTokens(entry.argsJson);
    out +=
      argsTokens > TRANSCRIPT_ARGS_MAX_TOKENS
        ? `ARGS: ${truncateToTokens(entry.argsJson, TRANSCRIPT_ARGS_MAX_TOKENS)}… [arguments clipped: ~${TRANSCRIPT_ARGS_MAX_TOKENS} of ~${argsTokens} tokens]\n`
        : `ARGS: ${entry.argsJson}\n`;
  }
  if (entry.resultText === undefined) return `${out}RESULT: (no result recorded)\n`;
  if (entry.resultText.length === 0) return `${out}RESULT: (no text content)\n`;

  const label = entry.resultIsError ? "RESULT (error)" : "RESULT";
  const total = estimateTokens(entry.resultText);
  if (total <= TRANSCRIPT_RESULT_MAX_TOKENS) return `${out}${label}:\n${entry.resultText}\n`;

  const offsets = needle ? matchOffsets(entry.resultText, needle) : [];
  if (offsets.length > 0) {
    return (
      `${out}${label} (~${total} tokens; ${offsets.length} match(es), shown in context):\n` +
      `${renderMatchWindows(entry.resultText, needle!, offsets, TRANSCRIPT_RESULT_MAX_TOKENS)}\n`
    );
  }
  return (
    `${out}${label}:\n${truncateToTokens(entry.resultText, TRANSCRIPT_RESULT_MAX_TOKENS)}…\n` +
    `[result clipped: first ~${TRANSCRIPT_RESULT_MAX_TOKENS} of ~${total} tokens. Pass query: "<term>" ` +
    "to see the passages around a term anywhere in this result.]\n"
  );
}

export function createReadSessionTranscriptTool(context: ReadSessionRecordToolContext): AgentTool {
  return {
    name: "read_session_transcript",
    label: "Read session transcript",
    description:
      "The raw tool calls (arguments + results) of an earlier session, for what its record " +
      "does not say (\"where exactly did you get that?\"). `query` keeps only calls whose name, " +
      "arguments or result contain it, and shows the passages around each match in long results. " +
      "`range` limits to turns; `offset` pages through long listings.",
    parameters: Type.Object({
      session_id: Type.String({ description: "The agent_session_id of the session." }),
      query: Type.Optional(
        Type.String({
          maxLength: 500,
          description:
            "Case-insensitive text to find in tool names, arguments or results (a URL, file name, " +
            "title, keyword). Omit to list every call.",
        }),
      ),
      range: Type.Optional(
        Type.Array(Type.Integer({ minimum: 1, maximum: 10000 }), {
          minItems: 2,
          maxItems: 2,
          description: "Inclusive [first, last] turn numbers (1-indexed turns with tool calls).",
        }),
      ),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Skip this many matching calls; the previous response's last line gives the value.",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { session_id: string; query?: string; range?: [number, number]; offset?: number };
      const { session_id } = args;
      const session = resolveReadableSession(session_id, context);

      const transcriptJson = context.storage.getAgentSessionTranscriptJson(session_id);
      if (!transcriptJson) {
        throw new Error(
          session.status === "running" || session.status === "created" || session.status === "resuming"
            ? `Session "${session_id}" is still running; its transcript is stored when it ends. Try again shortly.`
            : `No transcript was stored for session "${session_id}"; read_session_record(session_id: ` +
              `"${session_id}") is all there is.`,
        );
      }
      let messages: unknown[];
      try {
        const parsed = JSON.parse(transcriptJson) as unknown;
        messages = Array.isArray(parsed) ? parsed : [];
      } catch {
        throw new Error(`The stored transcript of session "${session_id}" is unreadable (corrupt JSON).`);
      }

      const { entries, totalTurns } = collectEntries(messages);
      const range = args.range;
      if (range && range[0] > range[1]) {
        throw new Error(`range [${range[0]}, ${range[1]}] is reversed; pass [${range[1]}, ${range[0]}].`);
      }
      const needle = args.query?.trim().toLowerCase() || undefined;
      const matching = entries.filter(
        (e) =>
          (!range || (e.turn >= range[0] && e.turn <= range[1])) &&
          (!needle ||
            e.name.toLowerCase().includes(needle) ||
            e.argsJson.toLowerCase().includes(needle) ||
            (e.resultText?.toLowerCase().includes(needle) ?? false)),
      );
      const offset = args.offset ?? 0;
      if (matching.length > 0 && offset >= matching.length) {
        throw new Error(
          `offset ${offset} is past the last matching call (${matching.length} match); ` +
            `pass an offset below ${matching.length}, or omit it to start from the first.`,
        );
      }

      const header =
        `Session ${session_id}: ${entries.length} tool call(s) over ${totalTurns} turn(s)` +
        (range ? `; turns ${range[0]}–${range[1]}` : "") +
        (needle ? `; query "${args.query!.trim()}"` : "") +
        `; ${matching.length} matching call(s).`;
      if (matching.length === 0) {
        const hint =
          entries.length === 0
            ? " The session made no tool calls; its chat messages are all there is."
            : ` Turns run 1–${totalTurns}; omit query/range to list every call.`;
        return {
          content: [{ type: "text", text: header + hint }],
          details: { session_id, totalTurns, totalCalls: entries.length, matching: 0, shown: 0 },
        };
      }

      const parts: string[] = [header];
      let budget = TRANSCRIPT_MAX_OUTPUT_TOKENS - estimateTokens(header);
      let lastTurn = -1;
      let shown = 0;
      for (const entry of matching.slice(offset)) {
        const turnLabel =
          entry.turn !== lastTurn ? `\n--- Turn ${entry.turn}${entry.isHarness ? " [harness]" : ""} ---\n` : "";
        const rendered = turnLabel + renderEntry(entry, needle);
        const cost = estimateTokens(rendered);
        // Always show at least one call; past that, stop before the bound.
        if (shown > 0 && cost > budget) break;
        parts.push(rendered);
        budget -= cost;
        lastTurn = entry.turn;
        shown++;
      }
      const end = offset + shown;
      parts.push(
        end < matching.length
          ? `\n[Shown matching calls ${offset + 1}–${end} of ${matching.length}. Next page: the same call with offset: ${end}.]`
          : `\n[Shown matching calls ${offset + 1}–${end} of ${matching.length}; that is all.]`,
      );

      return {
        content: [{ type: "text", text: parts.join("") }],
        details: { session_id, totalTurns, totalCalls: entries.length, matching: matching.length, offset, shown },
      };
    },
  };
}
