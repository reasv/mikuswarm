import type { ChatRole } from "../types.js";

export interface RenderedMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: number;
}

export interface ContextTurn {
  role: ChatRole;
  messageIds: string[];
  content: string;
  timestamp: number;
}

export function buildTurns(messages: RenderedMessage[]): ContextTurn[] {
  const turns: ContextTurn[] = [];
  for (const message of messages) {
    const previous = turns.at(-1);
    if (previous && previous.role === message.role) {
      previous.messageIds.push(message.id);
      previous.content = `${previous.content}\n\n---\n\n${message.content}`;
      previous.timestamp = message.timestamp;
    } else {
      turns.push({
        role: message.role,
        messageIds: [message.id],
        content: message.content,
        timestamp: message.timestamp,
      });
    }
  }
  return turns;
}
