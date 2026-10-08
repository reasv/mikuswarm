/**
 * Failure isolation for the background indexers (ARCHITECTURE.md §9d "Two
 * vector indexes", "Late interaction"): a batch request that fails is not
 * blamed on every block in it. A tiny canary request first tells an outage
 * (the canary fails too: nothing is blamed, the worker just slows down) from a
 * bad input; then the batch is bisected until the blocks that fail on their
 * own are found, and only those are recorded as failed. Their neighbours are
 * stored in the same pass.
 */

/** The canary input: short enough for any embedder or encoder. */
export const CANARY_TEXT = "ok";

export interface IsolatedBatch<T, R> {
  /** Items that were encoded, with their value. */
  ok: Array<{ item: T; value: R }>;
  /** Items that failed on their own while the provider served the canary. */
  bad: Array<{ item: T; error: string }>;
  /** Set when the canary failed too: an outage, nothing is blamed. */
  outage?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

/**
 * Run `items` through `run` (one request, values in input order); on failure
 * run `canary`, then bisect. Rethrows an abort. At most `2n - 1` batch
 * requests plus the canary for `n` items.
 */
export async function runIsolating<T, R>(
  items: T[],
  run: (items: T[]) => Promise<R[]>,
  canary: () => Promise<unknown>,
  signal?: AbortSignal,
): Promise<IsolatedBatch<T, R>> {
  const out: IsolatedBatch<T, R> = { ok: [], bad: [] };
  const attempt = async (list: T[]): Promise<string | null> => {
    try {
      const values = await run(list);
      if (values.length !== list.length) throw new Error(`provider returned ${values.length} results for ${list.length} inputs`);
      list.forEach((item, i) => out.ok.push({ item, value: values[i]! }));
      return null;
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      return messageOf(error);
    }
  };
  if (items.length === 0) return out;
  const first = await attempt(items);
  if (first === null) return out;
  try {
    await canary();
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    out.outage = first;
    return out;
  }
  const split = async (list: T[], error: string): Promise<void> => {
    if (list.length === 1) {
      out.bad.push({ item: list[0]!, error });
      return;
    }
    const mid = Math.ceil(list.length / 2);
    for (const half of [list.slice(0, mid), list.slice(mid)]) {
      const failed = await attempt(half);
      if (failed !== null) await split(half, failed);
    }
  };
  await split(items, first);
  return out;
}
