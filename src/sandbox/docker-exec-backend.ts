import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { ExecBackend, ExecOptions, ExecResult } from "./exec-backend.js";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Grace (seconds) the in-container coreutils `timeout` waits after its initial
 * SIGTERM before escalating to SIGKILL (`timeout -k`). Also the grace the abort
 * path waits between its own TERM and KILL of the in-container process group.
 */
const KILL_GRACE_SECS = 5;

/**
 * Duration (seconds) for the in-container `timeout` wrapper when the caller
 * requested NO wall-clock limit. The command still runs under `timeout` so it
 * lands in its own process group (which the abort path kills as a unit), but the
 * limit is effectively unbounded (30 days). Coreutils `timeout` accepts this and
 * the harness/container will be long gone first.
 */
const UNBOUNDED_TIMEOUT_SECS = 30 * 24 * 60 * 60;

/**
 * Spawns a `docker <args>` child and captures its output. Injectable so the
 * argv/kill construction can be unit-tested without a real Docker daemon. The
 * backend uses this both for the primary `docker exec` and for the out-of-band
 * `docker exec … kill` issued on abort.
 */
export type DockerSpawn = (
  args: string[],
  opts: { maxOutputBytes: number; signal?: AbortSignal },
) => Promise<RawExecResult>;

/**
 * Build the `docker exec` argv. Pure and side-effect free so it can be unit
 * tested. Modeled on OpenClaw's buildDockerExecArgs (bash-tools.shared.ts),
 * trimmed: Linux-only, no PTY, no custom-PATH prepend trick (we don't inject a
 * PATH — the image's ENV PATH and /etc/profile handle tool resolution).
 *
 * The in-container command is ALWAYS wrapped in coreutils `timeout` so the real
 * process tree can be killed inside the container regardless of what happens to
 * the local `docker exec` client (issue #1):
 *
 *   exec -i -w <wd> <container> timeout -s TERM -k <grace> <secs> /bin/sh -lc '<inner>'
 *
 * - `timeout` (coreutils, present in the image — docker/Dockerfile.sandbox
 *   installs `coreutils`) does two jobs:
 *   1. It runs the command in its OWN process group and, on the wall-clock
 *      limit, signals that whole group — so a timeout kills the real process
 *      tree (shell + grandchildren) inside the container even if the client is
 *      gone. It exits 124 on timeout (the code the backend maps to `timedOut`)
 *      and otherwise propagates the command's own exit code unchanged.
 *   2. That same process group is what the abort path kills as a unit (see
 *      buildAbortKillArgs) — `timeout` is always present so a killable group
 *      always exists, even when no wall-clock limit was requested.
 * - When the caller requests no timeout, `secs` is a 30-day sentinel
 *   (UNBOUNDED_TIMEOUT_SECS): effectively unbounded, but still under `timeout`
 *   so the process group exists.
 * - `<inner>` is `: <marker>; <command>` — a `:`-no-op carrying a unique marker
 *   in the shell's argv so the abort path can find this exec's process group
 *   with `pgrep -f` (see buildAbortKillArgs) without affecting behavior.
 */
export function buildDockerExecArgs(params: {
  containerName: string;
  command: string;
  workdir: string;
  env?: Record<string, string>;
  /** Wall-clock limit (whole seconds). Omit for an effectively unbounded limit. */
  timeoutSecs?: number;
  /** Unique per-exec marker embedded in the inner script for abort matching. */
  marker?: string;
}): string[] {
  const args = ["exec", "-i", "-w", params.workdir];
  for (const [key, value] of Object.entries(params.env ?? {})) {
    // PATH via -e poisons docker's own lookup on some hosts; the image sets it.
    if (key === "PATH") continue;
    args.push("-e", `${key}=${value}`);
  }
  // Absolute /bin/sh avoids depending on PATH during exec. Login shell (-l)
  // sources /etc/profile so brew/cargo/uv on the image PATH are reachable.
  // The marker is carried as a `:`-no-op argument so it appears verbatim in the
  // shell's /proc cmdline (pgrep -f match target) without altering the command.
  const inner = params.marker ? `: ${params.marker}; ${params.command}` : params.command;
  const secs =
    params.timeoutSecs !== undefined && params.timeoutSecs > 0
      ? params.timeoutSecs
      : UNBOUNDED_TIMEOUT_SECS;
  args.push(
    params.containerName,
    "timeout", "-s", "TERM", "-k", String(KILL_GRACE_SECS), String(secs),
    "/bin/sh", "-lc", inner,
  );
  return args;
}

/**
 * Build the out-of-band `docker exec … ` argv that kills the in-container
 * process group for `marker` with `signal` (TERM or KILL). Pure/testable.
 *
 * It greps for the marker, derives each matching process's PGID, and signals the
 * whole group (negative PID). The pgrep pattern brackets the marker's first char
 * (`[m]arker`) so the grep/pgrep process — whose own cmdline contains the literal
 * `[m]arker` — does not match itself (the classic ps|grep self-exclusion trick),
 * while the target shell (whose cmdline contains the bare `marker`) still does.
 */
export function buildAbortKillArgs(params: {
  containerName: string;
  marker: string;
  signal: "TERM" | "KILL";
}): string[] {
  const m = params.marker;
  const selfExcludingPattern = `[${m[0]}]${m.slice(1)}`;
  const script =
    `for pid in $(pgrep -f '${selfExcludingPattern}'); do ` +
    `pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' '); ` +
    `[ -n "$pgid" ] && kill -${params.signal} -"$pgid" 2>/dev/null; ` +
    `done; ` +
    `exit 0`;
  return ["exec", params.containerName, "/bin/sh", "-c", script];
}

/**
 * Map a workspace-relative cwd to the container path under workspaceMount,
 * rejecting `..` escapes (mirrors the containment intent of resolveWorkspacePath
 * in src/tools/workspace.ts). Returns workspaceMount itself when cwd is empty.
 */
export function mapContainerCwd(workspaceMount: string, cwd?: string): string {
  if (!cwd || cwd === "." || cwd === "./") return workspaceMount;
  const normalized = path.posix.normalize(cwd);
  if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
    throw new Error(`cwd escapes workspace: ${cwd}`);
  }
  return path.posix.join(workspaceMount, normalized);
}

/**
 * Trim a buffer back to the last complete UTF-8 sequence boundary, so decoding
 * never splits a multi-byte character into a U+FFFD replacement char (issue #9).
 * Returns the safe byte length to decode. Scans at most 3 trailing bytes (the
 * max continuation-byte run for a 4-byte sequence).
 */
function utf8SafeLength(buf: Buffer): number {
  let len = buf.length;
  if (len === 0) return 0;
  // Walk back over continuation bytes (10xxxxxx).
  let i = len - 1;
  let continuations = 0;
  while (i >= 0 && (buf[i] & 0xc0) === 0x80) {
    continuations++;
    i--;
    if (continuations > 3) return len; // not a real sequence; decode as-is
  }
  if (i < 0) return len; // all continuation bytes — leave to the decoder
  const lead = buf[i];
  // Expected sequence length encoded in the leading byte.
  let expected: number;
  if ((lead & 0x80) === 0x00) expected = 1; // ASCII
  else if ((lead & 0xe0) === 0xc0) expected = 2;
  else if ((lead & 0xf0) === 0xe0) expected = 3;
  else if ((lead & 0xf8) === 0xf0) expected = 4;
  else return len; // invalid lead byte; decode as-is (decoder substitutes)
  const have = continuations + 1;
  if (have >= expected) return len; // sequence is complete (or over-long; decode)
  return i; // sequence is truncated — drop it (decode up to the lead byte)
}

/** Collect a stream into a byte-capped buffer. Reports whether it overflowed. */
export class CappedSink {
  private chunks: Buffer[] = [];
  private size = 0;
  overflowed = false;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    if (this.size >= this.limit) {
      this.overflowed = true;
      return;
    }
    const remaining = this.limit - this.size;
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.size = this.limit;
      this.overflowed = true;
    } else {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
  }
  toString(): string {
    const buf = Buffer.concat(this.chunks);
    // When the cap clipped a chunk mid-character, the final bytes may be a
    // partial multi-byte sequence; trim to the last complete boundary so the
    // decode yields no U+FFFD at the cut (issue #9). The `truncated` flag
    // (overflowed) still reports that output was cut.
    return buf.toString("utf8", 0, utf8SafeLength(buf));
  }
}

export interface RawExecResult {
  stdout: string;
  stderr: string;
  code: number;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Spawn `docker <args>` and capture output. Ported/simplified from OpenClaw's
 * execDockerRaw: byte-capped collection, friendly ENOENT. Never rejects on
 * non-zero exit — the exit code is returned so callers (bash, ripgrep) can
 * interpret it. Rejects only on spawn errors (e.g. docker missing).
 */
function spawnDocker(
  args: string[],
  opts: { maxOutputBytes: number; signal?: AbortSignal },
): Promise<RawExecResult> {
  return new Promise<RawExecResult>((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = new CappedSink(opts.maxOutputBytes);
    const stderr = new CappedSink(opts.maxOutputBytes);

    // SIGTERM the local `docker exec` client on abort. This alone does NOT kill
    // the in-container process (no TTY with `exec -i`) — the backend's
    // out-of-band in-container kill does that — but tearing down the client is
    // still correct and releases the local handle promptly (issue #1).
    const onAbort = () => child.kill("SIGTERM");
    const signal = opts.signal;
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort);
    }
    const detach = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (c) => stdout.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    child.stderr?.on("data", (c) => stderr.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));

    child.on("error", (error) => {
      detach();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          Object.assign(
            new Error(
              'Sandbox is enabled but the "docker" command was not found in PATH. ' +
                "Install Docker, or set [sandbox].enabled=false to disable sandboxing.",
            ),
            { code: "DOCKER_NOT_FOUND", cause: error },
          ),
        );
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      detach();
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        code: code ?? 1,
        truncated: stdout.overflowed || stderr.overflowed,
        timedOut: false,
      });
    });

    child.stdin?.end();
  });
}

export interface DockerExecBackendOptions {
  containerName: string;
  /** Container path the workspace is mounted at, e.g. "/workspace". */
  workspaceMount: string;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  /**
   * Overrides the docker spawn (tests inject a fake to assert the argv/kill
   * construction without a real daemon). Defaults to the real spawn runner.
   */
  spawnDocker?: DockerSpawn;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createDockerExecBackend(options: DockerExecBackendOptions): ExecBackend {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const run = options.spawnDocker ?? spawnDocker;
  return {
    async exec(command: string, execOptions: ExecOptions = {}): Promise<ExecResult> {
      const workdir = mapContainerCwd(options.workspaceMount, execOptions.cwd);
      const timeoutMs = execOptions.timeoutMs ?? options.defaultTimeoutMs;
      const callMaxBytes = execOptions.maxOutputBytes ?? maxOutputBytes;
      // Convert to whole seconds for coreutils `timeout`; round up so a sub-second
      // request still yields at least 1s (timeout rejects 0).
      const timeoutSecs =
        timeoutMs !== undefined && timeoutMs > 0 ? Math.max(1, Math.ceil(timeoutMs / 1000)) : undefined;
      // Unique per-exec marker: lets the abort path find *this* exec's process
      // group inside the container (pgrep -f) without matching anything else.
      const marker = `mikuexec_${randomBytes(12).toString("hex")}`;

      const args = buildDockerExecArgs({
        containerName: options.containerName,
        command,
        workdir,
        env: execOptions.env,
        timeoutSecs,
        marker,
      });

      const callerSignal = execOptions.signal;

      // Abort kills the in-container process tree out-of-band: the local
      // `docker exec` client SIGTERM does NOT propagate into the container with
      // `exec -i` (no TTY), so the real process would otherwise orphan and
      // accumulate against --pids-limit (issue #1). TERM the group, wait a short
      // grace, then KILL any survivors. Best-effort: kill failures are logged
      // nowhere here but never block resolving the exec result.
      const killInContainer = async (): Promise<void> => {
        try {
          await run(buildAbortKillArgs({ containerName: options.containerName, marker, signal: "TERM" }), {
            maxOutputBytes: 4096,
          });
          await sleep(KILL_GRACE_SECS * 1000);
          await run(buildAbortKillArgs({ containerName: options.containerName, marker, signal: "KILL" }), {
            maxOutputBytes: 4096,
          });
        } catch {
          // The container may be gone, or the tree already dead — nothing to do.
        }
      };

      let aborted = false;
      let killPromise: Promise<void> | undefined;
      const onAbort = () => {
        if (aborted) return;
        aborted = true;
        killPromise = killInContainer();
      };
      if (callerSignal) {
        if (callerSignal.aborted) onAbort();
        else callerSignal.addEventListener("abort", onAbort);
      }

      try {
        const raw = await run(args, { maxOutputBytes: callMaxBytes, signal: callerSignal });
        // The in-container `timeout` exits 124 when the wall-clock limit fired
        // and otherwise propagates the command's own exit code. Only treat 124 as
        // a timeout when a real limit was requested (the no-timeout sentinel is
        // 30 days and won't realistically fire).
        const timedOut = timeoutSecs !== undefined && raw.code === 124;
        return {
          stdout: raw.stdout,
          stderr: raw.stderr,
          exitCode: raw.code,
          truncated: raw.truncated,
          timedOut,
        };
      } finally {
        if (callerSignal) callerSignal.removeEventListener("abort", onAbort);
        // If we aborted, make sure the out-of-band kill has been issued (and the
        // KILL escalation has run) before resolving, so no orphan survives. This
        // awaits the kill, not the (already-returned) exec, so it cannot hang on
        // a still-running command — the TERM/KILL has detached the tree.
        if (killPromise) await killPromise;
      }
    },
  };
}
