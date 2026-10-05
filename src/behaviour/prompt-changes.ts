/**
 * Observed prompt changes (spec REFUSAL-HANDLING §12.4 source 2): the system prompt
 * and the per-model prompts change without a restart when workspace files are
 * edited. Every agent-loop ledger row carries `system_prompt_hash` and
 * `model_prompt_hash`; a change in either between requests of the same agent, site
 * (session type) and served member becomes a `prompt_changed` event, hashes only.
 *
 * Detected at write time from the ledger fan-in (`recordUsageEvent`), with the last
 * hash per key kept in memory and seeded from the ledger at startup: no trigger, no
 * extra read per request. The key includes the site because session types render
 * different system prompts and resolve different model prompts.
 *
 * A session freezes its system prompt at creation, so after an edit the sessions
 * started earlier keep sending the old hash for a while. A hash seen for the key
 * within {@link PROMPT_FLAP_WINDOW_MS} is therefore not a change; only a hash that
 * is new (or returns after the window, a revert) is.
 */

import type { Logger } from "../observability/index.js";
import type { Storage } from "../storage/index.js";
import type { UsageEventInput } from "../storage/database.js";
import { recordBehaviourChanges } from "./changes.js";
import type { BehaviourChangeDraft } from "./types.js";

/** A hash seen this recently for the same key is an in-flight older (or newer) session, not a change. */
export const PROMPT_FLAP_WINDOW_MS = 60 * 60_000;
/** How far back the startup seed reads the ledger. */
export const PROMPT_SEED_LOOKBACK_MS = 30 * 86_400_000;

type PromptKind = "system" | "model";

interface HashState {
  current: string | null | undefined;
  /** hash ("" for none) → last time seen. */
  seen: Map<string, number>;
}

export interface PromptChangeTrackerOptions {
  storage: Storage;
  agentForTimelineKey(timelineKey: string | null): string | null;
  logger?: Logger;
  now?: () => number;
}

export class PromptChangeTracker {
  private readonly state = new Map<string, Record<PromptKind, HashState>>();
  private readonly now: () => number;

  constructor(private readonly options: PromptChangeTrackerOptions) {
    this.now = options.now ?? Date.now;
  }

  private key(agent: string | null, site: string, model: string): string {
    return `${agent ?? ""}\u0000${site}\u0000${model}`;
  }

  /**
   * Seed the last known hashes per (agent, site, model) from the ledger's latest
   * agent-loop row of each, within {@link PROMPT_SEED_LOOKBACK_MS}.
   */
  seed(): void {
    const since = this.now() - PROMPT_SEED_LOOKBACK_MS;
    const rows = this.options.storage.read(
      (db) =>
        db
          .prepare(
            `select timeline_key, coalesce(session_type, '') as site,
                    coalesce(nullif(logical_model_id, ''), model_id) as model,
                    model_prompt_hash, system_prompt_hash, max(ts) as ts
               from usage_events
              where class = 'agent_loop' and ts >= ?
              group by timeline_key, session_type, coalesce(nullif(logical_model_id, ''), model_id)`,
          )
          .all(since) as Array<{
          timeline_key: string | null; site: string; model: string;
          model_prompt_hash: string | null; system_prompt_hash: string | null; ts: number;
        }>,
    );
    // Several rooms fold into one agent: the newest row per key wins.
    rows.sort((a, b) => a.ts - b.ts);
    for (const r of rows) {
      const k = this.key(this.options.agentForTimelineKey(r.timeline_key), r.site, r.model);
      const st = this.entry(k);
      st.model.current = r.model_prompt_hash;
      st.model.seen.set(r.model_prompt_hash ?? "", r.ts);
      if (r.system_prompt_hash !== null) {
        st.system.current = r.system_prompt_hash;
        st.system.seen.set(r.system_prompt_hash, r.ts);
      }
    }
  }

  private entry(k: string): Record<PromptKind, HashState> {
    let st = this.state.get(k);
    if (!st) {
      st = { system: { current: undefined, seen: new Map() }, model: { current: undefined, seen: new Map() } };
      this.state.set(k, st);
    }
    return st;
  }

  /**
   * Compare one ledger row against the key's state; returns the change events (also
   * stored, best-effort). Rows without a system-prompt hash are not full agent-loop
   * requests of this feature (pre-feature rows, synthesized ledger rows) and are
   * ignored entirely.
   */
  observe(event: UsageEventInput): BehaviourChangeDraft[] {
    if (event.class !== "agent_loop" || !event.systemPromptHash) return [];
    const ts = event.ts ?? this.now();
    const agent = this.options.agentForTimelineKey(event.timelineKey ?? null);
    const site = event.sessionType ?? "";
    const model = event.logicalModelId || event.modelId;
    const st = this.entry(this.key(agent, site, model));
    const events: BehaviourChangeDraft[] = [];
    const check = (kind: PromptKind, hash: string | null) => {
      const s = st[kind];
      const seenKey = hash ?? "";
      const lastSeen = s.seen.get(seenKey);
      s.seen.set(seenKey, ts);
      if (s.current === undefined) {
        s.current = hash;
        return;
      }
      if (s.current === hash) return;
      if (lastSeen !== undefined && ts - lastSeen < PROMPT_FLAP_WINDOW_MS) return;
      const where = `${agent ? `agent ${agent}, ` : ""}${site || "session"} on ${model}`;
      events.push({
        kind: "prompt_changed",
        sentence: `${where}: ${kind === "system" ? "system prompt" : "model prompt"} changed (${s.current ?? "none"} → ${hash ?? "none"})`,
        agents: agent ? [agent] : [],
        sites: site ? [site] : [],
        models: [model],
        detail: { prompt: kind, oldHash: s.current, newHash: hash },
      });
      s.current = hash;
      // Forget hashes outside the window so the map stays small.
      for (const [h, seenAt] of s.seen) if (ts - seenAt >= PROMPT_FLAP_WINDOW_MS && h !== seenKey) s.seen.delete(h);
    };
    check("system", event.systemPromptHash);
    check("model", event.modelPromptHash ?? null);
    if (events.length > 0) {
      void recordBehaviourChanges(this.options.storage, events, ts).catch((error: unknown) => {
        this.options.logger?.warn("behaviour_change_insert_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      for (const e of events) this.options.logger?.info("prompt_changed", { ...e.detail, agent, site, model });
    }
    return events;
  }
}
