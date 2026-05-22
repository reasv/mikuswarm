import type { CanonicalChatEvent } from "../types.js";
import type { TimelineStore } from "./store.js";

export class AssistantEchoResolver {
  constructor(private readonly store: TimelineStore) {}

  async ingestOwnEcho(event: CanonicalChatEvent): Promise<"enriched" | "appended"> {
    return this.store.ingestAssistantEcho(event);
  }
}
