import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.flatMap((raw) => {
    const message = raw as any;
    if (!message || typeof message !== "object") return [];
    if (message.type === "chatEvent") {
      return [
        {
          role: "user",
          content: contentWithImages(message.content, message.imageBlocks),
          timestamp: message.timestamp ?? message.event?.timestamp ?? Date.now(),
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
    if (message.type === "runtimeInstructions") {
      return [
        {
          role: "user",
          content: contentWithImages(message.content, message.imageBlocks),
          timestamp: message.timestamp ?? Date.now(),
        },
      ];
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
