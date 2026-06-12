import os from "node:os";
import path from "node:path";
import type { DockerRunner } from "./manager.js";

/**
 * One entry of a container's `.Mounts` as reported by `docker inspect` —
 * `Source` is the host-side path the DAEMON resolved, `Destination` the
 * in-container path. Only the fields this module reads.
 */
export interface ContainerMount {
  Source: string;
  Destination: string;
}

/**
 * Translates an in-container path to its host-side equivalent using the
 * container's mount table: picks the mount whose `Destination` is the longest
 * path-prefix of `containerPath` and re-roots the remainder onto its `Source`.
 * Returns `undefined` when no mount covers the path (it lives on the container's
 * own filesystem and has no host-side identity).
 */
export function translateContainerPathToHost(
  mounts: readonly ContainerMount[],
  containerPath: string,
): string | undefined {
  // normalize() preserves trailing slashes; strip them (except on "/") so
  // "/app/ws/" and "/app/ws" compare equal.
  const norm = (p: string): string => {
    const n = path.posix.normalize(p);
    return n.length > 1 ? n.replace(/\/+$/, "") : n;
  };
  const target = norm(containerPath);
  let best: { dest: string; source: string } | undefined;
  for (const mount of mounts) {
    const dest = norm(mount.Destination);
    const prefix = dest.endsWith("/") ? dest : `${dest}/`;
    if (dest !== target && !target.startsWith(prefix)) continue;
    if (!best || dest.length > best.dest.length) best = { dest, source: mount.Source };
  }
  if (!best) return undefined;
  if (best.dest === target) return best.source;
  const remainder = target.slice(best.dest.length);
  const source = best.source.replace(/\/+$/, "");
  return remainder.startsWith("/") ? source + remainder : `${source}/${remainder}`;
}

/**
 * Resolves the host-side bind source for the sandbox workspace when the agent
 * itself runs in a container (`[sandbox].workspace_bind_source = "container"`).
 *
 * The sandbox is a SIBLING container: `docker create -v <src>:<dst>` sends
 * `<src>` to the host daemon, which resolves it in the HOST filesystem — the
 * agent's own mount namespace is irrelevant. Rather than configuring that host
 * path (which would pin the compose project to one absolute location), the
 * agent asks the daemon where its own workspace mount comes from: it inspects
 * its own container (the default container hostname is the container ID) and
 * translates the workspace path through the covering mount. No host path ever
 * appears in config; the compose project stays relocatable.
 *
 * Fail-fast: any failure here throws with a actionable message — a wrong bind
 * source must abort startup, not silently sandbox the wrong directory.
 */
export async function resolveWorkspaceBindSource(options: {
  runDocker: DockerRunner;
  /** Absolute agent-side workspace path (the resolved workspace root). */
  containerPath: string;
  /** Own container id/name; defaults to the hostname (= container ID). */
  selfId?: string;
}): Promise<string> {
  const selfId = options.selfId ?? os.hostname();
  const fail = (detail: string): never => {
    throw new Error(
      `[sandbox].workspace_bind_source = "container": ${detail}. The agent must run ` +
        `inside a container with /var/run/docker.sock mounted and its default hostname ` +
        `(= container ID — do not set "hostname:" on the compose service), with the ` +
        `workspace directory bind-mounted in (docker-compose.yml).`,
    );
  };
  const result = await options.runDocker(["inspect", "-f", "{{json .Mounts}}", selfId]);
  if (result.code !== 0) {
    fail(
      `failed to inspect own container "${selfId}" via the docker socket` +
        (result.stderr.trim() ? ` (${result.stderr.trim()})` : ` (exit ${result.code})`),
    );
  }
  let mounts: unknown;
  try {
    mounts = JSON.parse(result.stdout);
  } catch {
    fail(`own-container inspect of "${selfId}" returned unparseable mounts: ${result.stdout.slice(0, 200)}`);
  }
  if (!Array.isArray(mounts)) fail(`own-container inspect of "${selfId}" returned no mount list`);
  const mountList = (mounts as ContainerMount[]).filter(
    (m) => typeof m?.Source === "string" && typeof m?.Destination === "string",
  );
  const hostDir = translateContainerPathToHost(mountList, options.containerPath);
  if (hostDir === undefined) {
    fail(
      `no mount on own container "${selfId}" covers the workspace path ${options.containerPath} ` +
        `(mounts: ${mountList.map((m) => `${m.Source} → ${m.Destination}`).join(", ") || "none"})`,
    );
  }
  return hostDir as string;
}
