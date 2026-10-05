import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Storage } from "../storage/index.js";
import type { ChannelVisibilityResolver } from "../visibility/index.js";
import { shapeContentBlocks } from "../agent/tool-result-budget.js";
import { estimateTokens } from "../context/tokens.js";

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

// ── Visibility check ─────────────────────────────────────────────────────────

/**
 * Apply the same gate as `read_messages` to a session timeline key.
 * Returns an error string when access is denied, undefined when allowed.
 */
function checkSessionVisibility(
  sessionTimelineKey: string,
  context: ReadSessionRecordToolContext,
): string | undefined {
  if (context.visibilityResolver && context.currentTimelineKey) {
    const mode = context.visibilityResolver.modeFor(sessionTimelineKey);
    if (
      mode === "isolated" &&
      !context.visibilityResolver.sameChannel(sessionTimelineKey, context.currentTimelineKey)
    ) {
      return "Cannot access this session: it is in an isolated channel and this session is not in it.";
    }
  }
  return undefined;
}

/**
 * Check that `sessionAgentName` matches the current agent (multi-agent filter).
 * In single-agent mode (null currentAgentName) always allowed.
 */
function checkAgentOwnership(
  sessionTimelineKey: string,
  context: ReadSessionRecordToolContext,
): string | undefined {
  if (context.currentAgentName == null || !context.resolveAgentForTimeline) return undefined;
  const sessionAgent = context.resolveAgentForTimeline(sessionTimelineKey);
  if (sessionAgent !== null && sessionAgent !== context.currentAgentName) {
    return "Cannot access this session: it belongs to a different agent.";
  }
  return undefined;
}

// ── read_session_record ──────────────────────────────────────────────────────

export function createReadSessionRecordTool(context: ReadSessionRecordToolContext): AgentTool {
  return {
    name: "read_session_record",
    label: "Read session record",
    description:
      "Read the record for an earlier session. " +
      "Bot messages carry `agent_session_id`; pass it here. " +
      "Returns what was found or done, sources, and any open threads. " +
      "For the raw transcript, load the `sessions` skill and call `read_session_transcript`.",
    parameters: Type.Object({
      session_id: Type.String({ description: "The agent_session_id from a bot message." }),
    }),
    execute: async (_toolCallId, params) => {
      const { session_id } = params as { session_id: string };

      // Look up the session row to get its timeline key.
      const session = context.storage.getAgentSession(session_id);
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text:
                `No session found with id "${session_id}". ` +
                "Verify the agent_session_id from the bot message XML attribute.",
            },
          ],
          details: null,
          isError: true,
        };
      }

      // Visibility and ownership checks (same gate as read_messages).
      const visErr = checkSessionVisibility(session.timeline_key, context);
      if (visErr) {
        return { content: [{ type: "text", text: visErr }], details: null, isError: true };
      }
      const ownErr = checkAgentOwnership(session.timeline_key, context);
      if (ownErr) {
        return { content: [{ type: "text", text: ownErr }], details: null, isError: true };
      }

      // Check in-flight first (the record is being written right now).
      const isInFlight = context.isRecordInFlight?.(session_id) ?? false;
      if (isInFlight) {
        return {
          content: [
            {
              type: "text",
              text:
                "The session record is still being written. Try again in a moment.",
            },
          ],
          details: null,
          isError: true,
        };
      }

      // Look up the record.
      const record = context.storage.getSessionRecord(session_id);
      if (!record) {
        return {
          content: [
            {
              type: "text",
              text:
                `No record for session "${session_id}". ` +
                "This session either did no tool work (its messages are all there is) " +
                "or the record was not written. " +
                "To inspect the raw rollout, load the `sessions` skill and call `read_session_transcript`.",
            },
          ],
          details: null,
        };
      }

      // Parse builds_on.
      let buildsOn: string[] = [];
      try {
        buildsOn = JSON.parse(record.builds_on) as string[];
        if (!Array.isArray(buildsOn)) buildsOn = [];
      } catch {
        buildsOn = [];
      }

      const parts: string[] = [];
      parts.push(record.text);
      if (buildsOn.length > 0) {
        parts.push(`\nBuilds on: ${buildsOn.join(", ")} (call read_session_record for each to follow the chain).`);
      }
      parts.push(
        `\nFor the raw tool calls: load the \`sessions\` skill and call ` +
          `read_session_transcript(session_id: "${session_id}").`,
      );

      return {
        content: [{ type: "text", text: parts.join("") }],
        details: { session_id, tokenCount: record.token_count, buildsOn },
      };
    },
  };
}

// ── read_session_transcript ──────────────────────────────────────────────────

/** Max token budget per individual tool-result when rendering the transcript. */
const TRANSCRIPT_RESULT_MAX_TOKENS = 512;
/** Max token budget for one call's arguments (a file write or a heredoc can be huge). */
const TRANSCRIPT_ARGS_MAX_TOKENS = 256;
/** Max total output tokens for a transcript response. */
const TRANSCRIPT_MAX_OUTPUT_TOKENS = 4000;

type TranscriptMessage = {
  role?: string;
  type?: string;
  content?: unknown[];
  harness?: unknown;
  stopReason?: string;
};

type ToolCallBlock = { type: "toolCall"; id?: string; name?: string; arguments?: unknown };
type ToolResultBlock = { type: "toolResult"; toolCallId?: string; content?: { type: string; text?: string }[] };
type ThinkingBlock = { type: "thinking" };

function isThinkingBlock(b: unknown): b is ThinkingBlock {
  return typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "thinking";
}

/** Render one tool-call + result pair as a bounded text block. */
function renderToolPair(
  call: ToolCallBlock,
  result: ToolResultBlock | undefined,
  resultAllowance: number,
): string {
  const name = call.name ?? "(unknown)";
  const argsText = call.arguments !== undefined ? clipText(JSON.stringify(call.arguments), Math.min(TRANSCRIPT_ARGS_MAX_TOKENS, resultAllowance)) : "";
  let out = `TOOL CALL: ${name}\n`;
  if (argsText) out += `ARGS: ${argsText}\n`;

  if (!result) {
    out += "RESULT: (not found)\n";
    return out;
  }

  const resultContent = result.content ?? [];
  const textBlocks = resultContent
    .filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
    .map((b) => b.text ?? "");
  const rawText = textBlocks.join("\n");

  if (rawText.length === 0) {
    out += "RESULT: (no text content)\n";
    return out;
  }

  out += `RESULT:\n${clipText(rawText, resultAllowance)}\n`;
  return out;
}

/** Clip text to a token allowance with the tool-result budget's truncation marker. */
function clipText(text: string, allowance: number): string {
  const shaped = shapeContentBlocks([{ type: "text", text }], allowance, "per-result", false);
  return shaped.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
}

export function createReadSessionTranscriptTool(context: ReadSessionRecordToolContext): AgentTool {
  return {
    name: "read_session_transcript",
    label: "Read session transcript",
    description:
      "Read the raw tool calls and results from an earlier session's rollout. " +
      "Filter by `query` (case-insensitive substring of tool name, args, or result) " +
      "or `range` ([firstTurn, lastTurn], 1-indexed). " +
      "Use read_session_record first for the summary; drill into this for specific calls.",
    parameters: Type.Object({
      session_id: Type.String({ description: "The agent_session_id." }),
      query: Type.Optional(
        Type.String({
          maxLength: 500,
          description:
            "Case-insensitive substring filter on tool name, arguments, or result text. " +
            "Omit to see all tool calls.",
        }),
      ),
      range: Type.Optional(
        Type.Array(Type.Integer({ minimum: 1, maximum: 10000 }), {
          minItems: 2,
          maxItems: 2,
          description:
            "Inclusive [first, last] turn numbers (1-indexed assistant turns). " +
            "Omit to see all turns.",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { session_id: string; query?: string; range?: [number, number] };
      const { session_id } = args;

      // Session existence check.
      const session = context.storage.getAgentSession(session_id);
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text:
                `No session found with id "${session_id}". ` +
                "Verify the agent_session_id from the bot message XML attribute.",
            },
          ],
          details: null,
          isError: true,
        };
      }

      // Visibility and ownership checks.
      const visErr = checkSessionVisibility(session.timeline_key, context);
      if (visErr) return { content: [{ type: "text", text: visErr }], details: null, isError: true };
      const ownErr = checkAgentOwnership(session.timeline_key, context);
      if (ownErr) return { content: [{ type: "text", text: ownErr }], details: null, isError: true };

      // Load transcript.
      if (!session.transcript_json) {
        return {
          content: [
            {
              type: "text",
              text: `No transcript for session "${session_id}". The session may still be running or it was not persisted.`,
            },
          ],
          details: null,
        };
      }

      let messages: TranscriptMessage[];
      try {
        messages = JSON.parse(session.transcript_json) as TranscriptMessage[];
        if (!Array.isArray(messages)) messages = [];
      } catch {
        return {
          content: [{ type: "text", text: `Could not parse transcript for session "${session_id}".` }],
          details: null,
          isError: true,
        };
      }

      // Extract assistant turns (with tool calls), ignoring thinking blocks.
      // Build an index of toolResults keyed by toolCallId for quick lookup.
      //
      // Real pi-agent-core toolResult messages carry toolCallId at the MESSAGE
      // level (not inside a content block): { role: "toolResult", toolCallId, content: [...] }.
      // The previous per-block scan never found anything because content blocks are
      // TextContent/ImageContent only — there is no inner toolResult-typed block.
      const resultIndex = new Map<string, ToolResultBlock>();
      for (const msg of messages) {
        const m = msg as Record<string, unknown>;
        if (m["role"] === "toolResult" && typeof m["toolCallId"] === "string") {
          const content = Array.isArray(m["content"])
            ? (m["content"] as { type: string; text?: string }[])
            : [];
          resultIndex.set(m["toolCallId"], {
            type: "toolResult",
            toolCallId: m["toolCallId"],
            content,
          });
        }
      }

      // Collect turns: each assistant message with tool calls is one "turn".
      type TurnEntry = {
        turnIndex: number;    // 1-indexed
        isHarness: boolean;
        calls: ToolCallBlock[];
      };
      const turns: TurnEntry[] = [];
      let assistantTurnCount = 0;
      for (const msg of messages) {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const calls = msg.content
            .filter((b): b is ToolCallBlock => (b as { type?: string }).type === "toolCall")
            .filter((b) => !isThinkingBlock(b));
          if (calls.length === 0) continue;
          assistantTurnCount++;
          turns.push({
            turnIndex: assistantTurnCount,
            isHarness: typeof msg.harness === "object" && msg.harness !== null,
            calls,
          });
        }
      }

      const totalTurns = turns.length;
      const totalCalls = turns.reduce((n, t) => n + t.calls.length, 0);

      // Apply range filter.
      let filtered = turns;
      const range = args.range;
      if (range) {
        const [from, to] = range;
        filtered = turns.filter((t) => t.turnIndex >= from && t.turnIndex <= to);
      }

      // Apply query filter (case-insensitive substring over name, args, result).
      const query = args.query?.toLowerCase().trim();
      if (query) {
        filtered = filtered
          .map((turn) => {
            const matchedCalls = turn.calls.filter((call) => {
              const name = (call.name ?? "").toLowerCase();
              const argsStr = JSON.stringify(call.arguments ?? "").toLowerCase();
              if (name.includes(query) || argsStr.includes(query)) return true;
              const res = call.id ? resultIndex.get(call.id) : undefined;
              if (!res) return false;
              const resText = (res.content ?? [])
                .filter((b) => (b as { type?: string }).type === "text")
                .map((b) => ((b as { text?: string }).text ?? "").toLowerCase())
                .join(" ");
              return resText.includes(query);
            });
            return matchedCalls.length > 0 ? { ...turn, calls: matchedCalls } : null;
          })
          .filter((t): t is NonNullable<typeof t> => t !== null);
      }

      // Build output — bounded by TRANSCRIPT_MAX_OUTPUT_TOKENS.
      const headerParts: string[] = [`Session: ${session_id}`];
      headerParts.push(`Turns with tool calls: ${totalTurns}, total calls: ${totalCalls}`);
      if (range) headerParts.push(`Showing turns ${range[0]}–${range[1]}`);
      if (query) headerParts.push(`Filtered by query: "${args.query}"`);
      if (filtered.length === 0) {
        headerParts.push("No matching tool calls found.");
      }
      const header = headerParts.join(" | ");

      const parts: string[] = [header];
      let budgetRemaining = TRANSCRIPT_MAX_OUTPUT_TOKENS - estimateTokens(header);

      for (const turn of filtered) {
        if (budgetRemaining <= 0) {
          parts.push("[output truncated — use `range` or `query` to narrow]");
          break;
        }
        const turnLabel =
          `\n--- Turn ${turn.turnIndex}${turn.isHarness ? " [harness]" : ""} ---\n`;
        budgetRemaining -= estimateTokens(turnLabel);
        parts.push(turnLabel);

        for (const call of turn.calls) {
          if (budgetRemaining <= 0) {
            parts.push("[truncated]");
            break;
          }
          const res = call.id ? resultIndex.get(call.id) : undefined;
          const rendered = renderToolPair(call, res, Math.min(TRANSCRIPT_RESULT_MAX_TOKENS, budgetRemaining));
          budgetRemaining -= estimateTokens(rendered);
          parts.push(rendered);
        }
      }

      if (filtered.length > 0 && budgetRemaining > 0 && (query || range)) {
        const hint =
          `\nShown: ${filtered.length} turn(s). ` +
          (range ? "Adjust range to see other turns. " : "") +
          (query ? "Adjust query to see other calls." : "");
        parts.push(hint);
      }

      return {
        content: [{ type: "text", text: parts.join("") }],
        details: { session_id, totalTurns, totalCalls, shown: filtered.length },
      };
    },
  };
}
