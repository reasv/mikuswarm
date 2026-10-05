/**
 * Scripted fake OpenAI-completions endpoint for app- and factory-level tests.
 *
 * Every POST is parsed and recorded; the script decides the streamed answer: a
 * text reply, one or more tool calls, or an HTTP error. Models configured with
 * `api = "openai-completions"` and `endpoint = <url>` talk to it through the real
 * pi-ai transport, so a test exercises the same wire path as production.
 */

import http from "node:http";

export interface FakeLlmToolCall {
  name: string;
  args: unknown;
}

export interface FakeLlmReply {
  text?: string;
  toolCalls?: FakeLlmToolCall[];
  /** HTTP error instead of a stream. */
  error?: { status: number; body: string };
  /** Delay before answering (ms). */
  delayMs?: number;
  /** finish_reason override (default: "tool_calls" with calls, else "stop"). */
  finishReason?: string;
}

export interface FakeLlmRequest {
  index: number;
  body: {
    model?: string;
    messages: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>; tool_call_id?: string }>;
    tools?: Array<{ function: { name: string } }>;
  };
}

export interface FakeLlm {
  url: string;
  requests: FakeLlmRequest[];
  /** Decision-model (`api = "system-one"`) request bodies, in arrival order. */
  decisions: Array<{ state: unknown; questions: Record<string, { type: string; criteria?: unknown }> }>;
  close(): Promise<void>;
}

/** Probability a `noul` question gets, per decision request (default 0.9). */
export type DecideNoul = (body: { state: unknown; questions: Record<string, unknown> }) => number;

let callSeq = 0;

export async function startFakeLlm(
  script: (req: FakeLlmRequest) => FakeLlmReply | Promise<FakeLlmReply>,
  decideNoul: DecideNoul = () => 0.9,
): Promise<FakeLlm> {
  const requests: FakeLlmRequest[] = [];
  const decisions: FakeLlm["decisions"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        let body: FakeLlmRequest["body"];
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400).end("bad json");
          return;
        }
        // A decision-model request (system-one): answer every question.
        const decision = body as unknown as { state?: unknown; questions?: Record<string, { type: string; criteria?: unknown }> };
        if (decision.questions && "state" in decision) {
          decisions.push({ state: decision.state, questions: decision.questions });
          const answers: Record<string, unknown> = {};
          for (const [id, q] of Object.entries(decision.questions)) {
            if (q.type === "noul") answers[id] = { noul: decideNoul(decision as { state: unknown; questions: Record<string, unknown> }) };
            else if (q.type === "choice") {
              answers[id] = { choice: Object.keys(q.criteria as Record<string, unknown>)[0], confidence: 0.95 };
            } else answers[id] = { score: 0, confidence: 0.95 };
          }
          res.writeHead(200, { "Content-Type": "application/json" }).end(
            JSON.stringify({ model: "fake-decider-1", answers, usage: { input_tokens: 10, output_tokens: 1 } }),
          );
          return;
        }
        const request: FakeLlmRequest = { index: requests.length, body };
        requests.push(request);
        let reply: FakeLlmReply;
        try {
          reply = await script(request);
        } catch (error) {
          res.writeHead(500).end(String(error));
          return;
        }
        if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
        if (reply.error) {
          res.writeHead(reply.error.status, { "Content-Type": "application/json" }).end(reply.error.body);
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const id = `c${request.index}`;
        const chunk = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        const base = { id, object: "chat.completion.chunk", created: 1, model: body.model ?? "fake" };
        if (reply.text) {
          chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null }] });
        }
        (reply.toolCalls ?? []).forEach((call, i) => {
          callSeq += 1;
          chunk({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  ...(i === 0 && !reply.text ? { role: "assistant" } : {}),
                  tool_calls: [
                    {
                      index: i,
                      id: `call_${callSeq}`,
                      type: "function",
                      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
        });
        const finish = reply.finishReason ?? ((reply.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop");
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
        chunk({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
        res.write("data: [DONE]\n\n");
        res.end();
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    decisions,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Concatenated text of a request message's content (string or parts). */
export function messageText(message: { content?: unknown } | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "object" && p && "text" in p ? String((p as { text: unknown }).text) : "")).join("");
  }
  return "";
}

/** True when the request is a session-record turn (its record prompt is in the messages). */
export function isRecordTurnRequest(req: FakeLlmRequest): boolean {
  // The newest user turn: a resumed rollout carries an earlier record turn's prompt.
  const lastUser = req.body.messages.filter((m) => m.role === "user").at(-1);
  return messageText(lastUser).includes("Write its session record");
}

/** Names of the tools a request declared. */
export function requestToolNames(req: FakeLlmRequest): string[] {
  return (req.body.tools ?? []).map((t) => t.function.name);
}
