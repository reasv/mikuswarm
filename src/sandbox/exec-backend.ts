/**
 * The swappable exec boundary for sandboxed tool calls.
 *
 * Today the only implementation is {@link createDockerExecBackend} (spawns the
 * host `docker exec`). When the harness itself is containerized, the transport
 * can be swapped (mounted docker socket, or an exec-agent daemon over a unix
 * socket) without touching the tools that depend on this interface — `bash`
 * (src/tools/bash.ts) and `search_files` (src/tools/file.ts).
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when stdout/stderr were clipped to honor maxOutputBytes. */
  truncated: boolean;
  /** True when the command was killed because timeoutMs elapsed. */
  timedOut: boolean;
}

export interface ExecOptions {
  /**
   * Working directory, RELATIVE to the workspace root. The backend maps it to
   * the container path (e.g. /workspace/<cwd>) and rejects `..` escapes.
   * Defaults to the workspace root.
   */
  cwd?: string;
  /** Extra environment variables for the command. */
  env?: Record<string, string>;
  /** Kill the command after this many ms. Undefined = no timeout. */
  timeoutMs?: number;
  /** Caller cancellation (e.g. a session steer/abort). Merged with timeoutMs. */
  signal?: AbortSignal;
  /** Cap on captured stdout/stderr bytes (each stream). */
  maxOutputBytes?: number;
}

export interface ExecBackend {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}
