/**
 * Participant tags from provenance (ARCHITECTURE.md §9d "Participant tags").
 *
 * Every pipeline-written diary block comes from one level-1 summary range: one
 * room, a time range, a known set of source events with stable sender ids. Its
 * header (`## <start> → <end> · <TZ> · <ROOM>`) names the range to the minute,
 * so the block is tagged with the human sender ids of that range's events and
 * their message counts: exact (ids, not names), free (a join over stored data),
 * and immune to display-name changes. Header-less legacy blocks get no tags.
 *
 * The tagger works on blocks that have no provenance row yet, so the one-off
 * backfill of existing blocks and the incremental tagging of new ones are the
 * same pass. A block whose range matches no summary is recorded `none`; one
 * whose range matches several (two rooms with the same minute-range) is
 * disambiguated by the room label when the caller can resolve labels, else
 * recorded `ambiguous` with no tags.
 */
import type { Logger } from "../observability/logger.js";
import { parseZonedWallClock } from "../time/index.js";
import type { Level1Range, MemoryRetrievalStore } from "../storage/memory-retrieval-store.js";

const HEADER_RE =
  /^##\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+→\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+·\s+(\S+)\s+·\s+(.+?)\s*$/;

export interface ParsedDiaryHeader {
  startTs: number;
  endTs: number;
  timezone: string;
  room: string;
}

/** Parse a block's canonical diary header line (its first line), or null. */
export function parseDiaryHeaderLine(text: string): ParsedDiaryHeader | null {
  const first = text.split("\n", 1)[0] ?? "";
  const m = HEADER_RE.exec(first);
  if (!m) return null;
  const startTs = parseZonedWallClock(m[1]!, m[3]!);
  const endTs = parseZonedWallClock(m[2]!, m[3]!);
  if (startTs === null || endTs === null) return null;
  return { startTs, endTs, timezone: m[3]!, room: m[4]!.trim() };
}

const minute = (ts: number): number => Math.floor(ts / 60_000) * 60_000;

export interface ParticipantTaggerOptions {
  store: MemoryRetrievalStore;
  /** The agent owning a timeline (agents mode); absent = legacy (every range qualifies). */
  agentForTimeline?: (timelineKey: string) => string | null | undefined;
  /** The room label the diary writer rendered for a timeline, to break ties. */
  roomLabelFor?: (timelineKey: string) => Promise<string | undefined> | string | undefined;
  logger?: Logger;
  now?: () => number;
  /** Blocks per pass (each pass reloads the summary ranges). */
  batchSize?: number;
}

export interface TagPassResult {
  tagged: number;
  none: number;
  ambiguous: number;
}

export class ParticipantTagger {
  private running: Promise<TagPassResult> | null = null;
  private rerun = false;

  constructor(private readonly options: ParticipantTaggerOptions) {}

  /**
   * Tag every block without provenance. Coalesces concurrent calls: a call
   * while a pass runs schedules one more pass after it.
   */
  run(): Promise<TagPassResult> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      const total: TagPassResult = { tagged: 0, none: 0, ambiguous: 0 };
      try {
        do {
          this.rerun = false;
          for (;;) {
            const pass = await this.pass();
            total.tagged += pass.tagged;
            total.none += pass.none;
            total.ambiguous += pass.ambiguous;
            if (pass.tagged + pass.none + pass.ambiguous === 0) break;
          }
        } while (this.rerun);
      } finally {
        this.running = null;
      }
      if (total.tagged + total.none + total.ambiguous > 0) {
        this.options.logger?.info("memory_participants_tagged", { ...total });
      }
      return total;
    })();
    return this.running;
  }

  private async pass(): Promise<TagPassResult> {
    const { store } = this.options;
    const result: TagPassResult = { tagged: 0, none: 0, ambiguous: 0 };
    const blocks = store.chunksMissingProvenance(this.options.batchSize ?? 500);
    if (blocks.length === 0) return result;
    const byRange = indexRanges(store.level1Ranges());
    const now = (this.options.now ?? Date.now)();
    for (const block of blocks) {
      const headerText = block.text.startsWith("## ")
        ? block.text
        : store.headerChunkAbove(block.agent, block.path, block.startLine);
      const header = headerText ? parseDiaryHeaderLine(headerText) : null;
      let status: "tagged" | "none" | "ambiguous" = "none";
      let match: Level1Range | undefined;
      if (header) {
        const picked = await this.pick(byRange.get(`${minute(header.startTs)}:${minute(header.endTs)}`) ?? [], block.agent, header.room);
        status = picked.status;
        match = picked.match;
      }
      const participants = match ? store.summaryHumanSenders(match.id) : [];
      await store.setProvenance({
        agent: block.agent,
        contentHash: block.contentHash,
        status,
        summaryId: match?.id ?? null,
        timelineKey: match?.timelineKey ?? null,
        participants,
        at: now,
      });
      result[status] += 1;
    }
    return result;
  }

  private async pick(
    candidates: Level1Range[],
    agent: string,
    room: string,
  ): Promise<{ status: "tagged" | "none" | "ambiguous"; match?: Level1Range }> {
    let list = candidates;
    const resolveAgent = this.options.agentForTimeline;
    if (agent !== "" && resolveAgent) list = list.filter((r) => (resolveAgent(r.timelineKey) ?? null) === agent);
    if (list.length === 0) return { status: "none" };
    if (list.length > 1) {
      const done = list.filter((r) => r.diaryStatus === "done");
      if (done.length > 0) list = done;
    }
    if (list.length > 1 && this.options.roomLabelFor) {
      const label = room.trim().toLowerCase();
      const labels = await Promise.all(
        list.map(async (r) => {
          try {
            return (await this.options.roomLabelFor!(r.timelineKey))?.trim().toLowerCase();
          } catch {
            return undefined;
          }
        }),
      );
      const byLabel = list.filter((_, i) => labels[i] === label);
      if (byLabel.length > 0) list = byLabel;
    }
    if (list.length > 1) {
      // Mirrors of one donor range share its events: equivalent provenance.
      const roots = new Set(list.map((r) => r.mirroredFrom ?? r.id));
      if (roots.size === 1) return { status: "tagged", match: list.find((r) => r.mirroredFrom === null) ?? list[0]! };
      return { status: "ambiguous" };
    }
    return { status: "tagged", match: list[0]! };
  }
}

function indexRanges(ranges: Level1Range[]): Map<string, Level1Range[]> {
  const out = new Map<string, Level1Range[]>();
  for (const r of ranges) {
    const key = `${minute(r.earliestTimestamp)}:${minute(r.latestTimestamp)}`;
    const list = out.get(key);
    if (list) list.push(r);
    else out.set(key, [r]);
  }
  return out;
}
