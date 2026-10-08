/**
 * The `user` scope of `recall_memory` (ARCHITECTURE.md §9d "Participant tags"):
 * blocks whose source conversation included the person (provenance tags), plus
 * blocks that name them (current or earlier display names) as a second signal.
 * The person is given as a sender id (as the agent sees it in context) or a
 * display name.
 */
import type { MemoryRetrievalStore } from "../storage/memory-retrieval-store.js";
import type { Storage } from "../storage/index.js";
import { userLaneTokens } from "./search.js";

export interface UserScope {
  /** Chunk rowids in scope. */
  rowids: number[];
  /** Names searched (for the tool's header). */
  names: string[];
  /** Sender ids matched through provenance tags. */
  senderIds: string[];
}

const MAX_SCOPE = 5000;

export function resolveUserScope(
  storage: Storage,
  store: MemoryRetrievalStore,
  user: string,
  agent: string | null,
): UserScope {
  const needle = user.trim().replace(/^@/, "");
  const lower = needle.toLowerCase();
  const senders = store.distinctParticipantSenders(agent);
  const matched: Array<{ provider: string; senderId: string }> = [];
  const names = new Set<string>();
  const byId = senders.filter((s) => s.senderId.toLowerCase() === lower || s.senderId.toLowerCase().replace(/^@/, "") === lower);
  if (byId.length > 0) matched.push(...byId);
  else {
    for (const s of senders) {
      const history = store.senderDisplayNameHistory(s.provider, s.senderId, 5);
      if (history.some((n) => n.toLowerCase() === lower)) {
        matched.push(s);
        for (const n of history) names.add(n);
      }
    }
  }
  for (const s of matched) for (const n of store.senderDisplayNameHistory(s.provider, s.senderId, 5)) names.add(n);
  if (names.size === 0 && !/^[@!#]/.test(user.trim())) names.add(needle);
  const rowids = new Set<number>();
  for (const row of store.chunksWithParticipants(agent, matched, MAX_SCOPE)) rowids.add(row.rowid);
  const tokens = userLaneTokens([...names]);
  if (tokens.length > 0) {
    try {
      for (const hit of storage.searchMemoryLexical({
        match: `{text} : (${tokens.map((t) => `"${t}"`).join(" OR ")})`,
        limit: MAX_SCOPE,
        agent: agent ?? undefined,
      })) {
        rowids.add(hit.rowid);
      }
    } catch {
      // a lexical failure leaves the provenance scope alone
    }
  }
  return { rowids: [...rowids], names: [...names], senderIds: matched.map((m) => m.senderId) };
}
