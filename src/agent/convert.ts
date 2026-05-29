import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, TextContent, Usage } from "@earendil-works/pi-ai";

const STUB_USAGE: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.flatMap((raw) => {
    const message = raw as any;
    if (!message || typeof message !== "object") return [];

    if (message.type === "chatEvent") {
      if (message.role === "assistant") {
        return [
          {
            role: "assistant",
            content: [{ type: "text", text: message.content } as TextContent],
            api: "anthropic-messages",
            provider: "synthetic",
            model: "history",
            usage: STUB_USAGE,
            stopReason: "stop",
            timestamp: message.timestamp ?? Date.now(),
          } as AssistantMessage,
        ];
      }
      return [
        {
          role: "user",
          content: contentWithImages(message.content, message.imageBlocks),
          timestamp: message.timestamp ?? Date.now(),
        } as Message,
      ];
    }

    if (message.type === "triggerGroup" || message.type === "satellite") {
      return [
        {
          role: "user",
          content: contentWithImages(message.content, message.imageBlocks),
          timestamp: message.timestamp ?? Date.now(),
        } as Message,
      ];
    }

    if ("role" in message) {
      if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
        return [message as Message];
      }
      if (message.role === "system") return [];
      return [];
    }

    if (message.type === "interjection") {
      return [
        {
          role: "user",
          content: `<interjection>\n${message.content}\n</interjection>`,
          timestamp: Date.now(),
        },
      ];
    }

    return [];
  });
}

function contentWithImages(
  text: string,
  imageBlocks: Array<{ dataBase64: string; mediaType: string }> | undefined,
): string | (TextContent | ImageContent)[] {
  if (!imageBlocks?.length) return text;
  return [
    { type: "text", text },
    ...imageBlocks.map(
      (block): ImageContent => ({
        type: "image",
        data: block.dataBase64,
        mimeType: block.mediaType,
      }),
    ),
  ];
}
