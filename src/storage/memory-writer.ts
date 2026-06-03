import { mkdir, readFile, stat, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath, workspaceRelative } from "../tools/workspace.js";
import { runTextEditorCommand, type TextEditorArgs } from "../tools/file.js";

/**
 * Single-writer FIFO for all `memory/YYYY-MM-DD.md` mutations (ARCHITECTURE.md §9b).
 *
 * After the diary feature, the diary worker **appends** to day files while chat
 * sessions may concurrently `write_memory`-edit the same file. There is no other
 * serialization for memory files, so a concurrent read-modify-write would corrupt.
 * Every memory-file mutation — `ensureDailyFile` + `appendEntry` (diary) and
 * `editorCommand` (`write_memory`) — routes through one global FIFO, mirroring the
 * SQLite single-writer microtask queue idiom.
 *
 * The queue is a single `tail` promise chain: each `enqueue(op)` runs strictly
 * after the previous op settles. A rejected op propagates to *its* caller but
 * never poisons the chain (the chain advances on a swallowed copy). One global
 * queue is sufficient — memory writes are low-volume; per-path keying is a trivial
 * future optimization, noted but not built.
 *
 * Crash safety: `appendFile` is a single syscall; a torn/duplicate append is the
 * already-accepted §4 crash-window cost (the DB stays the idempotency authority).
 * No journaling, consistent with the existing stance.
 */
export class MemoryFileWriter {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly workspaceRoot: string) {}

  /** Strict-FIFO enqueue. The op runs after all previously-enqueued ops settle. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op);
    // Advance the chain on a swallowed copy so one rejection can't poison the rest.
    this.tail = run.catch(() => {});
    return run;
  }

  /**
   * Ensure `memory/<date>.md` exists (creating it with the `# <date> Daily Memory`
   * top header if absent) and return its absolute path. This is now the sole
   * routine creator of day files; the top header is single-`#` so it can never
   * collide with the diary's `^##` entry regex (§4/§10a).
   */
  ensureDailyFile(date: string): Promise<string> {
    return this.enqueue(() => this.#ensureDailyFile(date));
  }

  async #ensureDailyFile(date: string): Promise<string> {
    const memoryDir = resolveWorkspacePath(this.workspaceRoot, "memory");
    await mkdir(memoryDir, { recursive: true });
    const memoryPath = path.join(memoryDir, `${date}.md`);
    try {
      await stat(memoryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(memoryPath, `# ${date} Daily Memory\n`, "utf8");
    }
    return memoryPath;
  }

  /**
   * Append a diary `block` to `memory/<date>.md`, guaranteeing a `\n\n` boundary
   * before it (so the multiline `^##` split-regex stays valid) — §9b. The block
   * begins with the dictated `## ` header and is expected to end with `\n`.
   */
  appendEntry(date: string, block: string): Promise<void> {
    return this.enqueue(async () => {
      const memoryPath = await this.#ensureDailyFile(date);
      const current = await readFile(memoryPath, "utf8");
      const trailingNewlines = /(\n*)$/.exec(current)?.[1].length ?? 0;
      const padding = "\n".repeat(Math.max(0, 2 - trailingNewlines));
      const normalizedBlock = block.endsWith("\n") ? block : `${block}\n`;
      await appendFile(memoryPath, `${padding}${normalizedBlock}`, "utf8");
    });
  }

  /**
   * Run a text-editor command (view/str_replace/insert) against a memory file
   * through the same FIFO, so `write_memory`'s edits serialize with diary appends.
   */
  editorCommand(args: TextEditorArgs): ReturnType<typeof runTextEditorCommand> {
    return this.enqueue(() => runTextEditorCommand(this.workspaceRoot, args));
  }

  /** Workspace-relative form of an absolute memory path (for tool result details). */
  relative(absolutePath: string): string {
    return workspaceRelative(this.workspaceRoot, absolutePath);
  }
}
