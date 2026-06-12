import assert from "node:assert/strict";
import test from "node:test";
import {
  translateContainerPathToHost,
  resolveWorkspaceBindSource,
  type ContainerMount,
} from "../src/sandbox/host-path.js";
import type { DockerRunner } from "../src/sandbox/manager.js";

const MOUNTS: ContainerMount[] = [
  { Source: "/run/docker.sock", Destination: "/var/run/docker.sock" },
  { Source: "/home/op/miku/workspaces/miku", Destination: "/app/workspaces/miku" },
  { Source: "/home/op/miku/var", Destination: "/app/var" },
];

test("translate: exact destination match returns the mount source", () => {
  assert.equal(
    translateContainerPathToHost(MOUNTS, "/app/workspaces/miku"),
    "/home/op/miku/workspaces/miku",
  );
});

test("translate: path under a mount re-roots the remainder onto the source", () => {
  assert.equal(
    translateContainerPathToHost(MOUNTS, "/app/workspaces/miku/memory/notes.md"),
    "/home/op/miku/workspaces/miku/memory/notes.md",
  );
});

test("translate: longest covering destination wins over a shorter one", () => {
  const nested: ContainerMount[] = [
    { Source: "/host/outer", Destination: "/app" },
    { Source: "/host/inner", Destination: "/app/workspaces/miku" },
  ];
  assert.equal(
    translateContainerPathToHost(nested, "/app/workspaces/miku/x"),
    "/host/inner/x",
  );
  assert.equal(translateContainerPathToHost(nested, "/app/var"), "/host/outer/var");
});

test("translate: sibling prefix is NOT a path prefix (/app/ws vs /app/ws2)", () => {
  const mounts: ContainerMount[] = [{ Source: "/host/ws", Destination: "/app/ws" }];
  assert.equal(translateContainerPathToHost(mounts, "/app/ws2"), undefined);
});

test("translate: no covering mount returns undefined", () => {
  assert.equal(translateContainerPathToHost(MOUNTS, "/tmp/elsewhere"), undefined);
});

test("translate: root destination mount covers everything", () => {
  const mounts: ContainerMount[] = [{ Source: "/host/root", Destination: "/" }];
  assert.equal(translateContainerPathToHost(mounts, "/app/ws"), "/host/root/app/ws");
});

test("translate: normalizes trailing slashes on both sides", () => {
  const mounts: ContainerMount[] = [{ Source: "/host/ws/", Destination: "/app/ws/" }];
  assert.equal(translateContainerPathToHost(mounts, "/app/ws/sub/"), "/host/ws/sub");
});

function fakeRunner(handler: (args: string[]) => { stdout: string; stderr: string; code: number }): DockerRunner {
  return async (args) => handler(args);
}

test("resolve: inspects self and returns the translated host dir", async () => {
  let inspected: string[] | undefined;
  const run = fakeRunner((args) => {
    inspected = args;
    return { stdout: JSON.stringify(MOUNTS), stderr: "", code: 0 };
  });
  const hostDir = await resolveWorkspaceBindSource({
    runDocker: run,
    containerPath: "/app/workspaces/miku",
    selfId: "abc123def456",
  });
  assert.equal(hostDir, "/home/op/miku/workspaces/miku");
  assert.deepEqual(inspected, ["inspect", "-f", "{{json .Mounts}}", "abc123def456"]);
});

test("resolve: failed self-inspect throws an actionable error", async () => {
  const run = fakeRunner(() => ({ stdout: "", stderr: "No such object: myhost", code: 1 }));
  await assert.rejects(
    () => resolveWorkspaceBindSource({ runDocker: run, containerPath: "/app/workspaces/miku", selfId: "myhost" }),
    /failed to inspect own container "myhost".*No such object/s,
  );
});

test("resolve: no covering mount throws and lists the mounts seen", async () => {
  const run = fakeRunner(() => ({
    stdout: JSON.stringify([{ Source: "/host/var", Destination: "/app/var" }]),
    stderr: "",
    code: 0,
  }));
  await assert.rejects(
    () => resolveWorkspaceBindSource({ runDocker: run, containerPath: "/app/workspaces/miku", selfId: "x" }),
    /no mount on own container "x" covers the workspace path \/app\/workspaces\/miku.*\/host\/var → \/app\/var/s,
  );
});

test("resolve: unparseable inspect output throws", async () => {
  const run = fakeRunner(() => ({ stdout: "not-json", stderr: "", code: 0 }));
  await assert.rejects(
    () => resolveWorkspaceBindSource({ runDocker: run, containerPath: "/app/ws", selfId: "x" }),
    /unparseable mounts/,
  );
});

test("resolve: malformed mount entries are skipped, valid ones still resolve", async () => {
  const run = fakeRunner(() => ({
    stdout: JSON.stringify([
      { Name: "anon-volume", Destination: "/data" },
      { Source: "/host/ws", Destination: "/app/ws" },
    ]),
    stderr: "",
    code: 0,
  }));
  const hostDir = await resolveWorkspaceBindSource({ runDocker: run, containerPath: "/app/ws", selfId: "x" });
  assert.equal(hostDir, "/host/ws");
});
