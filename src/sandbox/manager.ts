import { spawn } from "node:child_process";
import type { Logger } from "../observability/logger.js";
import { createDockerExecBackend } from "./docker-exec-backend.js";
import type { ExecBackend, ExecOptions, ExecResult } from "./exec-backend.js";
import { resolveWorkspaceBindSource } from "./host-path.js";

/**
 * Runs a single `docker` CLI invocation to completion and returns its captured
 * output. Implementations must reject (not hang) when the daemon is unresponsive.
 * Injectable so tests can drive the manager without a real Docker daemon.
 */
export type DockerRunner = (args: string[]) => Promise<DockerResult>;

export interface SandboxManagerOptions {
  image: string;
  containerName: string;
  network: string;
  /**
   * DNS servers passed as `--dns`. Undefined ⇒ ["1.1.1.1", "8.8.8.8"] (default).
   * Empty array ⇒ NO --dns: required when `network` is a "container:…"/"host"
   * namespace join, where Docker forbids --dns — the sandbox then inherits that
   * namespace's resolver (e.g. a VPN anchor's tunnel DNS). See [sandbox].dns.
   */
  dns?: string[];
  /**
   * Workspace path bind-mounted into the sandbox. With `workspaceBindSource`
   * "host" (default) this IS the host path the daemon resolves. With
   * "container" it is the agent-side path, translated to its host-side mount
   * source at ensure() time by inspecting the agent's own container
   * (src/sandbox/host-path.ts) — the agent is then itself containerized and
   * its paths mean nothing to the daemon.
   */
  workspaceHostDir: string;
  /** How workspaceHostDir maps to the daemon's namespace ([sandbox].workspace_bind_source). */
  workspaceBindSource?: "host" | "container";
  /** Container path the workspace is mounted at, e.g. "/workspace". */
  workspaceMount: string;
  uid: number;
  gid: number;
  memory?: string;
  cpus?: number;
  pidsLimit?: number;
  readOnlyRoot?: boolean;
  env?: Record<string, string>;
  /** Extra bind mounts, each a raw `host:container[:mode]` spec. */
  binds?: string[];
  execTimeoutMs: number;
  maxOutputBytes: number;
  logger: Logger;
  /**
   * Overrides the docker CLI runner (tests inject a fake). Defaults to the real
   * spawn-based runner with a wall-clock timeout.
   */
  runDocker?: DockerRunner;
}

interface DockerResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface ContainerState {
  exists: boolean;
  running: boolean;
  /** The image ID the existing container was created from (`.Image`). */
  imageId?: string;
  /** Current image ID the requested image tag resolves to. */
  requestedImageId?: string;
  /** Bind-mount source mounted at the requested `workspace_mount`, if any. */
  workspaceMountSource?: string;
  /** The `uid:gid` the existing container was created with (`.Config.User`). */
  user?: string;
}

/**
 * Wall-clock bound on every lifecycle `docker` call. A hung/unresponsive daemon
 * must not block startup forever — the child is killed and the call rejects with
 * a clear error. This also bounds each readiness probe (issue #11).
 */
const DOCKER_CALL_TIMEOUT_MS = 30_000;

/**
 * Ceiling on buffered stdout/stderr per lifecycle docker call. These commands
 * (inspect/create/start/exec true) produce tiny output; this caps a misconfigured
 * daemon streaming a large error from growing memory unboundedly (issue #13).
 */
const DOCKER_OUTPUT_CAP_BYTES = 256 * 1024;

/**
 * The sandbox image's HOME (`docker/Dockerfile.sandbox`: `useradd sandbox`,
 * `ENV HOME=/home/sandbox`). Under `read_only_root` this path is backed by a
 * writable tmpfs so cargo/uv/brew/npm installs keep working (issue #7).
 */
const SANDBOX_HOME = "/home/sandbox";

/** Accumulates buffer chunks up to a fixed byte ceiling, dropping the overflow. */
class CappedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly cap: number) {}
  push(chunk: Buffer): void {
    if (this.size >= this.cap) return;
    const room = this.cap - this.size;
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(slice);
    this.size += slice.length;
  }
  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function runDockerReal(args: string[]): Promise<DockerResult> {
  return new Promise<DockerResult>((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = new CappedBuffer(DOCKER_OUTPUT_CAP_BYTES);
    const err = new CappedBuffer(DOCKER_OUTPUT_CAP_BYTES);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        Object.assign(
          new Error(
            `docker daemon unresponsive: "docker ${args.join(" ")}" exceeded ${DOCKER_CALL_TIMEOUT_MS}ms`,
          ),
          { code: "DOCKER_TIMEOUT" },
        ),
      );
    }, DOCKER_CALL_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (c) => out.push(Buffer.from(c)));
    child.stderr?.on("data", (c) => err.push(Buffer.from(c)));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: out.toString(),
        stderr: err.toString(),
        code: code ?? 1,
      });
    });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Owns the long-lived sandbox container's lifecycle and delegates command
 * execution to a docker-exec ExecBackend. Drives the raw `docker` CLI
 * (network/image/container create/start/inspect/exec), modeled on OpenClaw's
 * ensureSandboxContainer — trimmed of its registry/config-hash/scope machinery
 * since miku uses a single global workspace and one shared container.
 */
export class SandboxManager implements ExecBackend {
  /**
   * Single-flight guard (issue #15): concurrent/repeat `ensure()` calls share one
   * in-flight promise so they can't race `docker create --name`. Cleared on
   * failure so a later call can retry, and on success (a settled container needs
   * no further guarding — the create path is idempotent on subsequent calls).
   */
  private static inFlight: Promise<SandboxManager> | undefined;

  private constructor(
    private readonly options: SandboxManagerOptions,
    private readonly backend: ExecBackend,
  ) {}

  private static runner(options: SandboxManagerOptions): DockerRunner {
    return options.runDocker ?? runDockerReal;
  }

  static ensure(options: SandboxManagerOptions): Promise<SandboxManager> {
    if (SandboxManager.inFlight) return SandboxManager.inFlight;
    const run = SandboxManager.ensureUnguarded(options).then(
      (manager) => {
        SandboxManager.inFlight = undefined;
        return manager;
      },
      (error) => {
        SandboxManager.inFlight = undefined;
        throw error;
      },
    );
    SandboxManager.inFlight = run;
    return run;
  }

  private static async ensureUnguarded(requested: SandboxManagerOptions): Promise<SandboxManager> {
    const options = await SandboxManager.withResolvedBindSource(requested);
    const { logger } = options;
    await SandboxManager.ensureNetwork(options);
    await SandboxManager.assertImageExists(options);
    await SandboxManager.ensureContainerRunning(options);
    await SandboxManager.waitForReady(options);
    logger.info("sandbox_container_ready", {
      container: options.containerName,
      image: options.image,
      network: options.network,
    });
    const backend = createDockerExecBackend({
      containerName: options.containerName,
      workspaceMount: options.workspaceMount,
      defaultTimeoutMs: options.execTimeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      // Base env (incl. TZ) is re-applied per exec so the configured zone holds
      // even against a long-lived container created before the zone was set.
      env: options.env,
    });
    return new SandboxManager(options, backend);
  }

  /**
   * In "container" bind-source mode, replaces workspaceHostDir with the host
   * path the daemon has on record for the agent's own workspace mount. Runs
   * before any container state is touched so the mismatch re-validation
   * (containerMismatch) compares host paths on both sides. A resolution
   * failure aborts startup (fail-fast) — see resolveWorkspaceBindSource.
   */
  private static async withResolvedBindSource(
    options: SandboxManagerOptions,
  ): Promise<SandboxManagerOptions> {
    if (options.workspaceBindSource !== "container") return options;
    const hostDir = await resolveWorkspaceBindSource({
      runDocker: SandboxManager.runner(options),
      containerPath: options.workspaceHostDir,
    });
    options.logger.info("sandbox_workspace_bind_resolved", {
      workspacePath: options.workspaceHostDir,
      hostDir,
    });
    return { ...options, workspaceHostDir: hostDir };
  }

  private static async ensureNetwork(options: SandboxManagerOptions): Promise<void> {
    const runDocker = SandboxManager.runner(options);
    const { network } = options;
    if (network === "bridge" || network === "none" || network === "host" || network.startsWith("container:")) {
      return; // built-in modes need no creation
    }
    const inspect = await runDocker(["network", "inspect", network]);
    if (inspect.code === 0) return;
    // Create with IPv6 disabled so the IPv4-only egress hardening
    // (docker/sandbox-egress-rules.sh) gives a closed boundary; a v6-enabled
    // bridge would route around the RFC1918 DROP rules.
    const create = await runDocker(["network", "create", "--driver", "bridge", "--ipv6=false", network]);
    if (create.code !== 0) {
      throw new Error(`Failed to create sandbox network ${network}: ${create.stderr.trim()}`);
    }
    // Warn loudly: a freshly created network has no egress firewall yet. The
    // bridge name is derived from the new network ID, so any previously applied
    // rules are now stale. The operator must (re)run sandbox-egress-rules.sh as
    // root to restore RFC1918 blocking for the current bridge.
    options.logger.warn("sandbox_network_created", {
      network,
      action: "run docker/sandbox-egress-rules.sh as root to (re)apply egress firewall for this bridge",
    });
  }

  private static async assertImageExists(options: SandboxManagerOptions): Promise<void> {
    const result = await SandboxManager.runner(options)(["image", "inspect", options.image]);
    if (result.code !== 0) {
      throw new Error(
        `Sandbox image not found: ${options.image}. Build it first with docker/build-sandbox.sh, ` +
          "or set [sandbox].enabled=false to disable sandboxing.",
      );
    }
  }

  private static async ensureContainerRunning(options: SandboxManagerOptions): Promise<void> {
    const runDocker = SandboxManager.runner(options);
    const state = await SandboxManager.containerState(options, options.containerName);
    if (state.exists) {
      // Reuse re-validates against the requested config (issue #6): with
      // stop_on_shutdown=false the named container persists across image/mount
      // changes, so an operator who retags the image or changes workspace_mount
      // would otherwise keep serving tool calls from a stale container — a silent
      // fail-open on correctness and the isolation boundary. If the live image ID
      // or the workspace bind-mount source no longer match, remove and recreate
      // rather than (re)using the stale container.
      const mismatch = SandboxManager.containerMismatch(options, state);
      if (mismatch) {
        options.logger.warn("sandbox_container_recreate", {
          container: options.containerName,
          reason: mismatch,
        });
        const remove = await runDocker(["rm", "-f", options.containerName]);
        if (remove.code !== 0) {
          throw new Error(
            `Failed to remove stale sandbox container ${options.containerName}: ${remove.stderr.trim()}`,
          );
        }
      } else if (state.running) {
        options.logger.info("sandbox_container_reused", { container: options.containerName });
        return;
      } else {
        // Exists, matches, but stopped — start it (preserves in-container state).
        const start = await runDocker(["start", options.containerName]);
        if (start.code !== 0) {
          throw new Error(`Failed to start sandbox container ${options.containerName}: ${start.stderr.trim()}`);
        }
        return;
      }
    }
    await SandboxManager.createContainer(options);
    const start = await runDocker(["start", options.containerName]);
    if (start.code !== 0) {
      throw new Error(`Failed to start sandbox container ${options.containerName}: ${start.stderr.trim()}`);
    }
    options.logger.info("sandbox_container_created", { container: options.containerName });
  }

  /**
   * Returns a human-readable reason string when the existing container no longer
   * matches the requested config (image ID, workspace bind-mount source, or
   * runtime user), or `undefined` when it still matches. The user is part of the
   * check because workspace file ownership must track the harness uid:gid — a
   * container left over from a run under a different uid (e.g. a root deployment
   * upgraded to the non-root compose user, §11c) would silently keep writing
   * files the harness user doesn't own. Broader cap/network comparison remains
   * intentionally out of scope (issue #6).
   */
  private static containerMismatch(
    options: SandboxManagerOptions,
    state: ContainerState,
  ): string | undefined {
    if (state.imageId !== undefined && state.requestedImageId !== undefined) {
      if (state.imageId !== state.requestedImageId) {
        return `image changed (running ${state.imageId.slice(0, 19)} != requested ${state.requestedImageId.slice(0, 19)})`;
      }
    }
    if (state.workspaceMountSource !== undefined) {
      if (state.workspaceMountSource !== options.workspaceHostDir) {
        return `workspace mount changed (running ${state.workspaceMountSource} != requested ${options.workspaceHostDir})`;
      }
    } else if (state.exists) {
      // The container has no bind mount at the requested container path at all —
      // it was created with a different workspace_mount. Treat as a mismatch.
      return `workspace mount missing at ${options.workspaceMount}`;
    }
    if (state.user !== undefined) {
      const requestedUser = `${options.uid}:${options.gid}`;
      if (state.user !== requestedUser) {
        return `runtime user changed (running ${state.user} != requested ${requestedUser})`;
      }
    }
    return undefined;
  }

  private static async createContainer(options: SandboxManagerOptions): Promise<void> {
    const args = [
      "create",
      "--name", options.containerName,
      "--network", options.network,
      "--user", `${options.uid}:${options.gid}`,
      "-v", `${options.workspaceHostDir}:${options.workspaceMount}`,
      "--workdir", options.workspaceMount,
      "--security-opt", "no-new-privileges:true",
      "--cap-drop", "ALL",
      "--pids-limit", String(options.pidsLimit ?? 512),
    ];
    // `--dns` is incompatible with a shared network namespace (`--network
    // container:…`/`host`), so an empty `dns` array omits it and the sandbox
    // inherits the joined namespace's resolver. Undefined keeps the historical
    // default. See [sandbox].dns.
    for (const server of options.dns ?? ["1.1.1.1", "8.8.8.8"]) {
      args.push("--dns", server);
    }
    if (options.memory) args.push("--memory", options.memory);
    if (options.cpus !== undefined) args.push("--cpus", String(options.cpus));
    if (options.readOnlyRoot) {
      // A read-only rootfs alone breaks the toolchain: pip/cargo/npm/brew/mktemp
      // all need a writable /tmp, and the image's HOME (/home/sandbox, per
      // docker/Dockerfile.sandbox — where CARGO_HOME/RUSTUP_HOME/brew live) must
      // stay writable for installs. Back both with tmpfs so everything inside the
      // container works normally even with --read-only (issue #7). The home tmpfs
      // is mounted over the build-time toolchains, so this trades brew/cargo cache
      // persistence for a writable home; the rootfs binaries on PATH still work.
      args.push("--read-only");
      args.push("--tmpfs", "/tmp:rw,exec,nosuid,nodev");
      args.push("--tmpfs", `${SANDBOX_HOME}:rw,exec,nosuid,nodev`);
    }
    for (const [key, value] of Object.entries(options.env ?? {})) {
      args.push("-e", `${key}=${value}`);
    }
    for (const bind of options.binds ?? []) {
      args.push("-v", bind);
    }
    args.push(options.image, "sleep", "infinity");

    const result = await SandboxManager.runner(options)(args);
    if (result.code !== 0) {
      throw new Error(`Failed to create sandbox container ${options.containerName}: ${result.stderr.trim()}`);
    }
  }

  private static async containerState(
    options: SandboxManagerOptions,
    name: string,
  ): Promise<ContainerState> {
    const runDocker = SandboxManager.runner(options);
    // One inspect pulls running-state, the container's image ID, the bind
    // source mounted at the requested workspace path (empty if none), and the
    // created-with user. Tab-joined so an empty field is still distinct.
    const tmpl =
      "{{.State.Running}}\t{{.Image}}\t" +
      `{{range .Mounts}}{{if eq .Destination "${options.workspaceMount}"}}{{.Source}}{{end}}{{end}}` +
      "\t{{.Config.User}}";
    const result = await runDocker(["inspect", "-f", tmpl, name]);
    if (result.code !== 0) return { exists: false, running: false };
    const [running = "", imageId = "", mountSource = "", user = ""] = result.stdout
      .replace(/\n$/, "")
      .split("\t");
    // Resolve the requested image tag to its current image ID so a retag that
    // points the tag at a new build is detected even though the name is unchanged.
    const imgInspect = await runDocker(["image", "inspect", "-f", "{{.Id}}", options.image]);
    const requestedImageId = imgInspect.code === 0 ? imgInspect.stdout.trim() : undefined;
    return {
      exists: true,
      running: running.trim() === "true",
      imageId: imageId.trim() || undefined,
      requestedImageId,
      workspaceMountSource: mountSource.length > 0 ? mountSource : undefined,
      user: user.trim() || undefined,
    };
  }

  /** Defeat the start race: `docker start` returns before PID 1 is exec-able. */
  private static async waitForReady(options: SandboxManagerOptions): Promise<void> {
    const runDocker = SandboxManager.runner(options);
    const attempts = 5;
    // Each probe goes through runDocker, so it inherits the wall-clock timeout
    // (issue #3) and can't hang. On final failure we surface the last probe's
    // exit code and stderr instead of a bare "did not become ready" (issue #11).
    let last: DockerResult | undefined;
    for (let i = 0; i < attempts; i++) {
      last = await runDocker(["exec", options.containerName, "true"]);
      if (last.code === 0) return;
      await sleep(200);
    }
    const detail = last
      ? ` (last probe exit ${last.code}${last.stderr.trim() ? `: ${last.stderr.trim()}` : ""})`
      : "";
    throw new Error(`Sandbox container ${options.containerName} did not become ready${detail}`);
  }

  exec(command: string, execOptions?: ExecOptions): Promise<ExecResult> {
    return this.backend.exec(command, execOptions);
  }

  async shutdown(opts: { stop: boolean }): Promise<void> {
    if (!opts.stop) return; // leave running for fast restarts
    try {
      // PID 1 is `sleep infinity`, which ignores SIGTERM, so a plain `docker stop`
      // always pays the full 10s grace before SIGKILL. The container holds no
      // state worth a graceful drain, so `-t 1` (SIGTERM then SIGKILL after 1s)
      // shuts down promptly (issue #10).
      await SandboxManager.runner(this.options)(["stop", "-t", "1", this.options.containerName]);
      this.options.logger.info("sandbox_container_stopped", { container: this.options.containerName });
    } catch (error) {
      this.options.logger.warn("sandbox_container_stop_failed", {
        container: this.options.containerName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
