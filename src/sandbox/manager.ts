import { spawn } from "node:child_process";
import type { Logger } from "../observability/logger.js";
import { createDockerExecBackend } from "./docker-exec-backend.js";
import type { ExecBackend, ExecOptions, ExecResult } from "./exec-backend.js";

export interface SandboxManagerOptions {
  image: string;
  containerName: string;
  network: string;
  /** Absolute host path bind-mounted into the container. */
  workspaceHostDir: string;
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
}

interface DockerResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runDocker(args: string[]): Promise<DockerResult> {
  return new Promise<DockerResult>((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (c) => out.push(Buffer.from(c)));
    child.stderr?.on("data", (c) => err.push(Buffer.from(c)));
    child.on("error", (error) => {
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
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
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
  private constructor(
    private readonly options: SandboxManagerOptions,
    private readonly backend: ExecBackend,
  ) {}

  static async ensure(options: SandboxManagerOptions): Promise<SandboxManager> {
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
    });
    return new SandboxManager(options, backend);
  }

  private static async ensureNetwork(options: SandboxManagerOptions): Promise<void> {
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
    const result = await runDocker(["image", "inspect", options.image]);
    if (result.code !== 0) {
      throw new Error(
        `Sandbox image not found: ${options.image}. Build it first with docker/build-sandbox.sh, ` +
          "or set [sandbox].enabled=false to disable sandboxing.",
      );
    }
  }

  private static async ensureContainerRunning(options: SandboxManagerOptions): Promise<void> {
    const state = await SandboxManager.containerState(options.containerName);
    if (state.running) {
      options.logger.info("sandbox_container_reused", { container: options.containerName });
      return;
    }
    if (state.exists) {
      // Exists but stopped — start it (preserves any persisted in-container state).
      const start = await runDocker(["start", options.containerName]);
      if (start.code !== 0) {
        throw new Error(`Failed to start sandbox container ${options.containerName}: ${start.stderr.trim()}`);
      }
      return;
    }
    await SandboxManager.createContainer(options);
    const start = await runDocker(["start", options.containerName]);
    if (start.code !== 0) {
      throw new Error(`Failed to start sandbox container ${options.containerName}: ${start.stderr.trim()}`);
    }
    options.logger.info("sandbox_container_created", { container: options.containerName });
  }

  private static async createContainer(options: SandboxManagerOptions): Promise<void> {
    const args = [
      "create",
      "--name", options.containerName,
      "--network", options.network,
      "--user", `${options.uid}:${options.gid}`,
      "-v", `${options.workspaceHostDir}:${options.workspaceMount}`,
      "--workdir", options.workspaceMount,
      "--dns", "1.1.1.1",
      "--dns", "8.8.8.8",
      "--security-opt", "no-new-privileges:true",
      "--cap-drop", "ALL",
      "--pids-limit", String(options.pidsLimit ?? 512),
    ];
    if (options.memory) args.push("--memory", options.memory);
    if (options.cpus !== undefined) args.push("--cpus", String(options.cpus));
    if (options.readOnlyRoot) args.push("--read-only");
    for (const [key, value] of Object.entries(options.env ?? {})) {
      args.push("-e", `${key}=${value}`);
    }
    for (const bind of options.binds ?? []) {
      args.push("-v", bind);
    }
    args.push(options.image, "sleep", "infinity");

    const result = await runDocker(args);
    if (result.code !== 0) {
      throw new Error(`Failed to create sandbox container ${options.containerName}: ${result.stderr.trim()}`);
    }
  }

  private static async containerState(name: string): Promise<{ exists: boolean; running: boolean }> {
    const result = await runDocker(["inspect", "-f", "{{.State.Running}}", name]);
    if (result.code !== 0) return { exists: false, running: false };
    return { exists: true, running: result.stdout.trim() === "true" };
  }

  /** Defeat the start race: `docker start` returns before PID 1 is exec-able. */
  private static async waitForReady(options: SandboxManagerOptions): Promise<void> {
    const attempts = 5;
    for (let i = 0; i < attempts; i++) {
      const probe = await runDocker(["exec", options.containerName, "true"]);
      if (probe.code === 0) return;
      await sleep(200);
    }
    throw new Error(`Sandbox container ${options.containerName} did not become ready`);
  }

  exec(command: string, execOptions?: ExecOptions): Promise<ExecResult> {
    return this.backend.exec(command, execOptions);
  }

  async shutdown(opts: { stop: boolean }): Promise<void> {
    if (!opts.stop) return; // leave running for fast restarts
    try {
      await runDocker(["stop", this.options.containerName]);
      this.options.logger.info("sandbox_container_stopped", { container: this.options.containerName });
    } catch (error) {
      this.options.logger.warn("sandbox_container_stop_failed", {
        container: this.options.containerName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
