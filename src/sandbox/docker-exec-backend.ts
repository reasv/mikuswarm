import { spawn } from "node:child_process";
import path from "node:path";
import type { ExecBackend, ExecOptions, ExecResult } from "./exec-backend.js";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Build the `docker exec` argv. Pure and side-effect free so it can be unit
 * tested. Modeled on OpenClaw's buildDockerExecArgs (bash-tools.shared.ts),
 * trimmed: Linux-only, no PTY, no custom-PATH prepend trick (we don't inject a
 * PATH — the image's ENV PATH and /etc/profile handle tool resolution).
 */
export function buildDockerExecArgs(params: {
  containerName: string;
  command: string;
  workdir: string;
  env?: Record<string, string>;
}): string[] {
  const args = ["exec", "-i", "-w", params.workdir];
  for (const [key, value] of Object.entries(params.env ?? {})) {
    // PATH via -e poisons docker's own lookup on some hosts; the image sets it.
    if (key === "PATH") continue;
    args.push("-e", `${key}=${value}`);
  }
  // Absolute /bin/sh avoids depending on PATH during exec. Login shell (-l)
  // sources /etc/profile so brew/cargo/uv on the image PATH are reachable.
  args.push(params.containerName, "/bin/sh", "-lc", params.command);
  return args;
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

/** Collect a stream into a byte-capped buffer. Reports whether it overflowed. */
class CappedSink {
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
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

interface RawExecResult {
  stdout: string;
  stderr: string;
  code: number;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Spawn `docker <args>` and capture output. Ported/simplified from OpenClaw's
 * execDockerRaw: byte-capped collection, SIGTERM on abort, friendly ENOENT.
 * Never rejects on non-zero exit — the exit code is returned so callers (bash,
 * ripgrep) can interpret it. Rejects only on spawn errors (e.g. docker missing).
 */
function execDockerRaw(
  args: string[],
  opts: { signal?: AbortSignal; maxOutputBytes: number; timeoutMs?: number },
): Promise<RawExecResult> {
  return new Promise<RawExecResult>((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = new CappedSink(opts.maxOutputBytes);
    const stderr = new CappedSink(opts.maxOutputBytes);
    let timedOut = false;
    let killed = false;

    const kill = () => {
      if (killed) return;
      killed = true;
      child.kill("SIGTERM");
    };

    const onAbort = () => kill();
    const callerSignal = opts.signal;
    if (callerSignal) {
      if (callerSignal.aborted) kill();
      else callerSignal.addEventListener("abort", onAbort);
    }

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMs);
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (c) => stdout.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    child.stderr?.on("data", (c) => stderr.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));

    child.on("error", (error) => {
      cleanup();
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
      cleanup();
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        // A killed process reports null/signal; surface 124 for timeout (conventional), else 137.
        code: code ?? (timedOut ? 124 : 137),
        truncated: stdout.overflowed || stderr.overflowed,
        timedOut,
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
}

export function createDockerExecBackend(options: DockerExecBackendOptions): ExecBackend {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return {
    async exec(command: string, execOptions: ExecOptions = {}): Promise<ExecResult> {
      const workdir = mapContainerCwd(options.workspaceMount, execOptions.cwd);
      const args = buildDockerExecArgs({
        containerName: options.containerName,
        command,
        workdir,
        env: execOptions.env,
      });
      const raw = await execDockerRaw(args, {
        signal: execOptions.signal,
        maxOutputBytes: execOptions.maxOutputBytes ?? maxOutputBytes,
        timeoutMs: execOptions.timeoutMs ?? options.defaultTimeoutMs,
      });
      return {
        stdout: raw.stdout,
        stderr: raw.stderr,
        exitCode: raw.code,
        truncated: raw.truncated,
        timedOut: raw.timedOut,
      };
    },
  };
}
