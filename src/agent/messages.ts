import type {} from "@earendil-works/pi-agent-core";
import type { ChatRole, CanonicalChatEvent } from "../types.js";
import type { ImageBlock, ContextMessage } from "../context/index.js";

export interface ChatEventMessage {
  type: "chatEvent";
  role: ChatRole;
  content: string;
  event?: CanonicalChatEvent;
  imageBlocks?: ImageBlock[];
  timestamp?: number;
}

export interface TriggerGroupMessage {
  type: "triggerGroup";
  content: string;
  imageBlocks?: ImageBlock[];
  timestamp?: number;
  /**
   * Per-message context tier + token estimate carried through from the
   * `ContextBuilder.build()` output (spec §10a/§11). Persisted on the transcript
   * head so the verbatim renderer's default-expanded final user turn shows the
   * real token estimate and contributes to tier subtotals, matching the
   * byte-identical room-mode turn. Optional: not present on resume-mode prompts.
   */
  tier?: ContextMessage["tier"];
  tokenEstimate?: number;
}

export interface SatelliteMessage {
  type: "satellite";
  content: string;
  imageBlocks?: ImageBlock[];
  timestamp?: number;
  /** See {@link TriggerGroupMessage.tier}/`tokenEstimate` — same purpose for the
   *  summarization-cutoff head turn. */
  tier?: ContextMessage["tier"];
  tokenEstimate?: number;
}

export interface InterjectionMessage {
  type: "interjection";
  content: string;
  /**
   * Real image pixels carried alongside the interjection text (spec
   * FOLLOWUP-FOLDING §3). The sole producer is a steered follow-up of the **media**
   * form: a forced-split image that arrived a beat after its triggering message and
   * is folded into the live session. Without this an image interjection degrades to
   * its caption; `convert.ts` turns these into `{type:"image"}` content blocks via
   * `contentWithImages`. A co-reply that itself carries an image rides the same field.
   */
  imageBlocks?: ImageBlock[];
}

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    chatEvent: ChatEventMessage;
    triggerGroup: TriggerGroupMessage;
    satellite: SatelliteMessage;
    interjection: InterjectionMessage;
  }
}
