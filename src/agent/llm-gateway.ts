import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
} from "@earendil-works/pi-ai";

export function streamLlmGateway(
  model: Model<"anthropic-messages">,
  context: Context,
  options: SimpleStreamOptions = {},
) {
  const stream = createAssistantMessageEventStream();
  void callLlmGateway(model, context, options, stream);
  return stream;
}

async function callLlmGateway(
  model: Model<"anthropic-messages">,
  context: Context,
  options: SimpleStreamOptions,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
): Promise<void> {
  const started = baseAssistant(model);
  stream.push({ type: "start", partial: started });
  try {
    const response = await fetch(messagesUrl(model.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": options.apiKey ?? "",
        authorization: `Bearer ${options.apiKey ?? ""}`,
        ...model.headers,
      },
      body: JSON.stringify({
        model: model.id,
        max_tokens: options.maxTokens ?? model.maxTokens,
        system: context.systemPrompt,
        messages: context.messages.flatMap(toAnthropicMessage),
        stream: false,
      }),
      signal: options.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as any;
    if (!response.ok) {
      throw new Error(`${response.status} ${JSON.stringify(payload)}`);
    }
    const text = extractText(payload);
    const message: AssistantMessage = {
      ...started,
      content: text ? [{ type: "text", text }] : [],
      responseId: payload.id,
      responseModel: payload.model,
      stopReason: payload.stop_reason === "max_tokens" ? "length" : "stop",
      usage: {
        input: payload.usage?.input_tokens ?? 0,
        output: payload.usage?.output_tokens ?? 0,
        cacheRead: payload.usage?.cache_read_input_tokens ?? 0,
        cacheWrite: payload.usage?.cache_creation_input_tokens ?? 0,
        totalTokens: (payload.usage?.input_tokens ?? 0) + (payload.usage?.output_tokens ?? 0),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    if (text) {
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
    }
    stream.push({ type: "done", reason: message.stopReason === "length" ? "length" : "stop", message });
  } catch (error) {
    const message: AssistantMessage = {
      ...started,
      stopReason: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
    stream.push({ type: "error", reason: "error", error: message });
  }
}

function baseAssistant(model: Model<"anthropic-messages">): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function messagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/messages")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

function toAnthropicMessage(message: Message): Array<{ role: "user" | "assistant"; content: any }> {
  if (message.role === "toolResult") return [];
  return [
    {
      role: message.role,
      content: typeof message.content === "string" ? message.content : message.content.map((content) => toAnthropicContent(content as any)),
    },
  ];
}

function toAnthropicContent(content: TextContent | { type: "image"; data: string; mimeType: string } | any): any {
  if (content.type === "text") return { type: "text", text: content.text };
  if (content.type !== "image") return { type: "text", text: "" };
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: content.mimeType,
      data: content.data,
    },
  };
}

function extractText(payload: any): string {
  if (typeof payload?.content === "string") return payload.content;
  if (Array.isArray(payload?.content)) {
    return payload.content
      .filter((block: any) => block?.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text)
      .join("");
  }
  return "";
}
