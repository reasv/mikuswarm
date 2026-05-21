import type {} from "@earendil-works/pi-agent-core";
import type { ChatRole, CanonicalChatEvent } from "../types.js";
import type { ImageBlock } from "../context/index.js";

export interface ChatEventMessage {
  type: "chatEvent";
  role: ChatRole;
  content: string;
  event?: CanonicalChatEvent;
  imageBlocks?: ImageBlock[];
}

export interface RuntimeInstructionsMessage {
  type: "runtimeInstructions";
  content: string;
  imageBlocks?: ImageBlock[];
}

export interface InterjectionMessage {
  type: "interjection";
  content: string;
}

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    chatEvent: ChatEventMessage;
    runtimeInstructions: RuntimeInstructionsMessage;
    interjection: InterjectionMessage;
  }
}
