import { parseTimelineKey } from "../storage/timeline-key.js";
import { randomUUID } from "node:crypto";
import type { ChannelVisibilityResolver } from "../visibility/index.js";
export interface ExaOwner { agent: string | null; timeline: string }
export interface StoredExaContent { id: string; owner: ExaOwner; url: string; title?: string; text: string; expires: number; bytes: number; extractionTruncated: boolean }
export function canReadExa(owner: ExaOwner, caller: ExaOwner, visibility?: ChannelVisibilityResolver): boolean {
  if (!parseTimelineKey(owner.timeline) || !parseTimelineKey(caller.timeline)) return false;
  return owner.agent === caller.agent && (owner.timeline === caller.timeline || !!visibility?.sameChannel(owner.timeline, caller.timeline) || (!!visibility && visibility.modeFor(owner.timeline) !== "isolated"));
}
/** Process-owned bounded content cache. Restart/eviction/expiry invalidates handles. */
export class ExaContentStore {
  private entries = new Map<string, StoredExaContent>(); private bytes = 0;
  constructor(private readonly maxBytes: number, private readonly ttlMs: number, private readonly now = Date.now) {}
  put(content: Omit<StoredExaContent, "id" | "expires" | "bytes">): string | undefined {
    this.evict(); const bytes = Buffer.byteLength(JSON.stringify(content)) + 256; if (bytes > this.maxBytes) return undefined;
    while (this.bytes + bytes > this.maxBytes && this.entries.size) this.remove(this.entries.keys().next().value!);
    const id = `exa_content_${randomUUID()}`; this.entries.set(id, { ...content, id, bytes, expires: this.now() + this.ttlMs }); this.bytes += bytes; return id;
  }
  get(id: string, caller: ExaOwner, visibility?: ChannelVisibilityResolver): StoredExaContent {
    this.evict(); const content = this.entries.get(id);
    if (!content || !canReadExa(content.owner, caller, visibility)) throw new Error("Exa content handle is expired, unavailable or outside this session's visibility. Call exa_fetch with the original URL to retrieve it again.");
    return content;
  }
  private remove(id: string) { const content = this.entries.get(id); if (content) { this.bytes -= content.bytes; this.entries.delete(id); } }
  private evict() { for (const [id, content] of this.entries) if (content.expires <= this.now()) this.remove(id); }
}
