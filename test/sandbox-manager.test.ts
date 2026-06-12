import assert from "node:assert/strict";
import test from "node:test";
import { SandboxManager, type SandboxManagerOptions, type DockerRunner } from "../src/sandbox/manager.js";

interface DockerResult {
  stdout: string;
  stderr: string;
  code: number;
}

const IMAGE_ID = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** Captures every warn/info call so tests can assert on lifecycle logging. */
function recordingLogger() {
  const calls: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const make = (): any => ({
    debug: (message: string, fields?: Record<string, unknown>) => calls.push({ level: "debug", message, fields }),
    info: (message: string, fields?: Record<string, unknown>) => calls.push({ level: "info", message, fields }),
    warn: (message: string, fields?: Record<string, unknown>) => calls.push({ level: "warn", message, fields }),
    error: (message: string, fields?: Record<string, unknown>) => calls.push({ level: "error", message, fields }),
    child: () => make(),
  });
  return { logger: make(), calls };
}

/**
 * Programmable docker runner. `handler` decides each call's result from the
 * subcommand; `log` records the full argv of every invocation so tests can count
 * create/rm/start calls.
 */
function fakeRunner(handler: (args: string[]) => DockerResult): {
  run: DockerRunner;
  log: string[][];
} {
  const log: string[][] = [];
  const run: DockerRunner = async (args) => {
    log.push(args);
    return handler(args);
  };
  return { run, log };
}

function baseOptions(over: Partial<SandboxManagerOptions> = {}): SandboxManagerOptions {
  const { logger } = recordingLogger();
  return {
    image: "mikuswarm-sandbox:24.04",
    containerName: "miku-test-sbx",
    network: "mikuswarm-sandbox",
    workspaceHostDir: "/host/workspace",
    workspaceMount: "/workspace",
    uid: 1000,
    gid: 1000,
    execTimeoutMs: 1000,
    maxOutputBytes: 1024,
    logger,
    ...over,
  };
}

const ok = (stdout = ""): DockerResult => ({ stdout, stderr: "", code: 0 });
const fail = (stderr = "", code = 1): DockerResult => ({ stdout: "", stderr, code });

test("ensure: single-flight — concurrent calls share one create path", async () => {
  let creates = 0;
  let containerExists = false;
  const { run, log } = fakeRunner((args) => {
    const [cmd, sub] = args;
    if (cmd === "network" && sub === "inspect") return ok();
    if (cmd === "image" && args[1] === "inspect") return ok(IMAGE_ID);
    if (cmd === "inspect") {
      // container state inspect
      if (!containerExists) return fail("No such object", 1);
      return ok(`true\t${IMAGE_ID}\t/host/workspace`);
    }
    if (cmd === "create") {
      creates++;
      containerExists = true;
      return ok();
    }
    if (cmd === "start") return ok();
    if (cmd === "exec") return ok(); // readiness probe
    return ok();
  });

  const opts = baseOptions({ runDocker: run });
  const [a, b] = await Promise.all([SandboxManager.ensure(opts), SandboxManager.ensure(opts)]);
  assert.ok(a === b, "concurrent ensure() calls resolve to the same manager");
  assert.equal(creates, 1, "exactly one create despite two concurrent ensure() calls");
  assert.equal(log.filter((a) => a[0] === "create").length, 1);
});

test("ensure: single-flight resets on failure so a later call retries", async () => {
  let attempts = 0;
  const { run } = fakeRunner((args) => {
    if (args[0] === "network" && args[1] === "inspect") return ok();
    if (args[0] === "image" && args[1] === "inspect") {
      attempts++;
      // First attempt fails (image missing); second succeeds.
      return attempts === 1 ? fail("No such image", 1) : ok(IMAGE_ID);
    }
    if (args[0] === "inspect") return fail("No such object", 1);
    if (args[0] === "create" || args[0] === "start" || args[0] === "exec") return ok();
    return ok();
  });

  const opts = baseOptions({ runDocker: run });
  await assert.rejects(() => SandboxManager.ensure(opts), /Sandbox image not found/);
  // Guard must have cleared — a fresh call retries rather than returning the
  // memoized rejection.
  const mgr = await SandboxManager.ensure(opts);
  assert.ok(mgr instanceof SandboxManager);
});

test("ensure: reuse recreates on image-ID mismatch", async () => {
  const { logger, calls } = recordingLogger();
  const seq: string[] = [];
  const { run } = fakeRunner((args) => {
    seq.push(args[0]);
    if (args[0] === "network" && args[1] === "inspect") return ok();
    if (args[0] === "image" && args[1] === "inspect") {
      // requested image resolves to the NEW id
      return ok(IMAGE_ID);
    }
    if (args[0] === "inspect") {
      // existing container was built from a DIFFERENT (stale) image id
      return ok(`true\tsha256:stale000000000000000000000000000000000000000000000000000000000\t/host/workspace`);
    }
    if (args[0] === "rm") return ok();
    if (args[0] === "create" || args[0] === "start" || args[0] === "exec") return ok();
    return ok();
  });

  const mgr = await SandboxManager.ensure(baseOptions({ runDocker: run, logger }));
  assert.ok(mgr instanceof SandboxManager);
  assert.ok(seq.includes("rm"), "stale container is removed");
  assert.ok(seq.includes("create"), "a fresh container is created");
  const recreate = calls.find((c) => c.message === "sandbox_container_recreate");
  assert.ok(recreate, "logs the recreate");
  assert.match(String(recreate?.fields?.reason), /image changed/);
});

test("ensure: reuse recreates on workspace bind-mount source mismatch", async () => {
  const { logger, calls } = recordingLogger();
  const seq: string[] = [];
  const { run } = fakeRunner((args) => {
    seq.push(args[0]);
    if (args[0] === "network" && args[1] === "inspect") return ok();
    if (args[0] === "image" && args[1] === "inspect") return ok(IMAGE_ID);
    if (args[0] === "inspect") {
      // same image, but mounted from a DIFFERENT host dir than requested
      return ok(`true\t${IMAGE_ID}\t/old/host/workspace`);
    }
    if (args[0] === "rm" || args[0] === "create" || args[0] === "start" || args[0] === "exec") return ok();
    return ok();
  });

  await SandboxManager.ensure(baseOptions({ runDocker: run, logger, workspaceHostDir: "/host/workspace" }));
  assert.ok(seq.includes("rm"), "stale container is removed on mount mismatch");
  const recreate = calls.find((c) => c.message === "sandbox_container_recreate");
  assert.match(String(recreate?.fields?.reason), /workspace mount changed/);
});

test("ensure: reuse keeps a matching running container (no recreate)", async () => {
  const { logger, calls } = recordingLogger();
  const seq: string[] = [];
  const { run } = fakeRunner((args) => {
    seq.push(args[0]);
    if (args[0] === "network" && args[1] === "inspect") return ok();
    if (args[0] === "image" && args[1] === "inspect") return ok(IMAGE_ID);
    if (args[0] === "inspect") return ok(`true\t${IMAGE_ID}\t/host/workspace`);
    if (args[0] === "exec") return ok(); // readiness
    return ok();
  });

  await SandboxManager.ensure(baseOptions({ runDocker: run, logger }));
  assert.ok(!seq.includes("rm"), "matching container is not removed");
  assert.ok(!seq.includes("create"), "matching container is not recreated");
  assert.ok(calls.some((c) => c.message === "sandbox_container_reused"), "logs reuse");
});

test("createContainer: read_only_root adds --read-only plus writable tmpfs for /tmp and home", async () => {
  let createArgs: string[] = [];
  const { run } = fakeRunner((args) => {
    if (args[0] === "network" && args[1] === "inspect") return ok();
    if (args[0] === "image" && args[1] === "inspect") return ok(IMAGE_ID);
    if (args[0] === "inspect") return fail("No such object", 1); // does not exist → create
    if (args[0] === "create") {
      createArgs = args;
      return ok();
    }
    if (args[0] === "start" || args[0] === "exec") return ok();
    return ok();
  });

  await SandboxManager.ensure(baseOptions({ runDocker: run, readOnlyRoot: true }));
  assert.ok(createArgs.includes("--read-only"), "passes --read-only");
  // tmpfs flags appear as `--tmpfs <spec>` pairs
  const tmpfsSpecs = createArgs.filter((_, i) => createArgs[i - 1] === "--tmpfs");
  assert.ok(tmpfsSpecs.some((s) => s.startsWith("/tmp")), "writable /tmp tmpfs");
  assert.ok(tmpfsSpecs.some((s) => s.startsWith("/home/sandbox")), "writable /home/sandbox tmpfs");
});

test("createContainer: read_only_root off adds no --read-only and no tmpfs", async () => {
  let createArgs: string[] = [];
  const { run } = fakeRunner((args) => {
    if (args[0] === "network" && args[1] === "inspect") return ok();
    if (args[0] === "image" && args[1] === "inspect") return ok(IMAGE_ID);
    if (args[0] === "inspect") return fail("No such object", 1);
    if (args[0] === "create") {
      createArgs = args;
      return ok();
    }
    return ok();
  });

  await SandboxManager.ensure(baseOptions({ runDocker: run, readOnlyRoot: false }));
  assert.ok(!createArgs.includes("--read-only"));
  assert.ok(!createArgs.includes("--tmpfs"));
});

test("waitForReady: surfaces the last probe's exit code and stderr on failure", async () => {
  const { run } = fakeRunner((args) => {
    if (args[0] === "network" && args[1] === "inspect") return ok();
    if (args[0] === "image" && args[1] === "inspect") return ok(IMAGE_ID);
    if (args[0] === "inspect") return fail("No such object", 1);
    if (args[0] === "create" || args[0] === "start") return ok();
    if (args[0] === "exec") return fail("container not running", 137);
    return ok();
  });

  await assert.rejects(
    () => SandboxManager.ensure(baseOptions({ runDocker: run })),
    /did not become ready \(last probe exit 137: container not running\)/,
  );
});

test("ensure: workspaceBindSource container resolves the bind source from own mounts", async () => {
  const { logger, calls } = recordingLogger();
  let createArgs: string[] = [];
  const { run } = fakeRunner((args) => {
    if (args[0] === "network" && args[1] === "inspect") return ok();
    if (args[0] === "image" && args[1] === "inspect") return ok(IMAGE_ID);
    if (args[0] === "inspect" && args[2] === "{{json .Mounts}}") {
      // self-inspect: agent's own container mounts
      return ok(JSON.stringify([{ Source: "/anywhere/repo/workspaces/miku", Destination: "/app/workspaces/miku" }]));
    }
    if (args[0] === "inspect") return fail("No such object", 1); // sandbox does not exist yet
    if (args[0] === "create") {
      createArgs = args;
      return ok();
    }
    if (args[0] === "start" || args[0] === "exec") return ok();
    return ok();
  });

  await SandboxManager.ensure(
    baseOptions({
      runDocker: run,
      logger,
      workspaceHostDir: "/app/workspaces/miku",
      workspaceBindSource: "container",
    }),
  );
  const volSpecs = createArgs.filter((_, i) => createArgs[i - 1] === "-v");
  assert.ok(
    volSpecs.includes("/anywhere/repo/workspaces/miku:/workspace"),
    `sandbox bind uses the translated host source (got: ${volSpecs.join(", ")})`,
  );
  const resolved = calls.find((c) => c.message === "sandbox_workspace_bind_resolved");
  assert.equal(resolved?.fields?.hostDir, "/anywhere/repo/workspaces/miku");
});

test("ensure: workspaceBindSource container reuse compares the RESOLVED host source", async () => {
  const { logger, calls } = recordingLogger();
  const seq: string[] = [];
  const { run } = fakeRunner((args) => {
    seq.push(args[0]);
    if (args[0] === "network" && args[1] === "inspect") return ok();
    if (args[0] === "image" && args[1] === "inspect") return ok(IMAGE_ID);
    if (args[0] === "inspect" && args[2] === "{{json .Mounts}}") {
      return ok(JSON.stringify([{ Source: "/anywhere/repo/workspaces/miku", Destination: "/app/workspaces/miku" }]));
    }
    // existing sandbox container already mounts the same resolved host dir
    if (args[0] === "inspect") return ok(`true\t${IMAGE_ID}\t/anywhere/repo/workspaces/miku`);
    if (args[0] === "exec") return ok();
    return ok();
  });

  await SandboxManager.ensure(
    baseOptions({
      runDocker: run,
      logger,
      workspaceHostDir: "/app/workspaces/miku",
      workspaceBindSource: "container",
    }),
  );
  assert.ok(!seq.includes("rm"), "matching resolved source is not treated as a mismatch");
  assert.ok(calls.some((c) => c.message === "sandbox_container_reused"));
});

test("ensure: workspaceBindSource container fails fast when no mount covers the workspace", async () => {
  const { run } = fakeRunner((args) => {
    if (args[0] === "inspect" && args[2] === "{{json .Mounts}}") {
      return ok(JSON.stringify([{ Source: "/anywhere/repo/var", Destination: "/app/var" }]));
    }
    return ok();
  });

  await assert.rejects(
    () =>
      SandboxManager.ensure(
        baseOptions({
          runDocker: run,
          workspaceHostDir: "/app/workspaces/miku",
          workspaceBindSource: "container",
        }),
      ),
    /no mount on own container .* covers the workspace path \/app\/workspaces\/miku/,
  );
});

test("shutdown: uses `docker stop -t 1` to skip the 10s grace", async () => {
  const seq: string[][] = [];
  const { run } = fakeRunner((args) => {
    seq.push(args);
    if (args[0] === "network" && args[1] === "inspect") return ok();
    if (args[0] === "image" && args[1] === "inspect") return ok(IMAGE_ID);
    if (args[0] === "inspect") return ok(`true\t${IMAGE_ID}\t/host/workspace`);
    if (args[0] === "exec") return ok();
    if (args[0] === "stop") return ok();
    return ok();
  });

  const mgr = await SandboxManager.ensure(baseOptions({ runDocker: run }));
  await mgr.shutdown({ stop: true });
  const stop = seq.find((a) => a[0] === "stop");
  assert.deepEqual(stop, ["stop", "-t", "1", "miku-test-sbx"]);
});
