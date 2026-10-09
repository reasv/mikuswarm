// =============================================================================
// Repetition guard (ARCHITECTURE.md §8a "Repetition guard"): spots a streamed
// generation that has collapsed into a loop — one short unit (a character, a
// word, a sentence, a paragraph) emitted back to back with no variation — so
// Layer 0 can cut the attempt off instead of paying for it to the output cap.
//
// Agent output is arbitrary (tables, code, card JSON, emoji, separators), so the
// guard trips only on what no legitimate turn produces: an EXACT periodic run.
// For every period p ≤ `max_period` it counts the consecutive streamed code units
// equal to the one p positions earlier; any variation resets that count. It trips
// when one count reaches both `min_chars` and (`min_repeats` − 1) · p, i.e. at
// least `min_repeats` identical copies of the unit back to back. Each content
// block (text, thinking, each tool call's argument stream) is watched separately.
// Cost: O(max_period) integer compares per streamed code unit.
// =============================================================================

export interface RepetitionGuardConfig {
  /** Repeated code units needed to trip (the run after the first copy of the unit). */
  min_chars: number;
  /** Longest repeating unit watched, in UTF-16 code units. */
  max_period: number;
  /** Fewest back-to-back copies of the unit that can trip. */
  min_repeats: number;
}

export const REPETITION_GUARD_DEFAULTS: RepetitionGuardConfig = {
  min_chars: 4000,
  max_period: 1024,
  min_repeats: 4,
};

export interface RepetitionTrip {
  contentIndex: number;
  /** Length of the repeating unit. */
  period: number;
  /** Repeated code units when the guard tripped (excludes the first copy). */
  runChars: number;
  /** Code units streamed in the block so far. */
  blockChars: number;
}

/** One content block's state: the last `maxPeriod` code units and the run per period. */
class BlockState {
  readonly ring: Uint16Array;
  readonly runs: Uint32Array;
  length = 0;
  constructor(maxPeriod: number) {
    this.ring = new Uint16Array(maxPeriod + 1);
    this.runs = new Uint32Array(maxPeriod + 1);
  }
}

/** Per-attempt detector; feed it every streamed delta. */
export class RepetitionDetector {
  private readonly blocks = new Map<number, BlockState>();
  private readonly cfg: RepetitionGuardConfig;

  constructor(cfg: Partial<RepetitionGuardConfig> = {}) {
    this.cfg = { ...REPETITION_GUARD_DEFAULTS, ...cfg };
  }

  /** Feed one delta of block `contentIndex`; returns the trip, if it tripped. */
  push(contentIndex: number, delta: string): RepetitionTrip | undefined {
    const { min_chars: minChars, max_period: maxPeriod, min_repeats: minRepeats } = this.cfg;
    let block = this.blocks.get(contentIndex);
    if (!block) {
      block = new BlockState(maxPeriod);
      this.blocks.set(contentIndex, block);
    }
    const { ring, runs } = block;
    const size = ring.length;
    for (let k = 0; k < delta.length; k++) {
      const c = delta.charCodeAt(k);
      const i = block.length;
      const top = Math.min(maxPeriod, i);
      for (let p = 1; p <= top; p++) {
        if (ring[(i - p) % size] === c) {
          const run = ++runs[p]!;
          if (run >= minChars && run >= (minRepeats - 1) * p) {
            return { contentIndex, period: p, runChars: run, blockChars: i + 1 };
          }
        } else {
          runs[p] = 0;
        }
      }
      ring[i % size] = c;
      block.length = i + 1;
    }
    return undefined;
  }
}
