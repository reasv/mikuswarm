import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createUserProfileEditTool,
  createUserProfileReadTool,
  type UserProfileToolContext,
} from "../src/tools/user-profile.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-userprofile-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function buildContext(overrides: Partial<UserProfileToolContext> & { workspaceRoot: string }): UserProfileToolContext {
  return {
    provider: "matrix",
    senderId: "@alice:example.org",
    senderDisplayName: "Alice",
    ...overrides,
    config: { root_dir: "users", ...(overrides.config ?? {}) },
  };
}

async function runRead(context: UserProfileToolContext, params: unknown): Promise<any> {
  const tool = createUserProfileReadTool(context);
  return await (tool.execute as any)("test-call", params);
}

async function runEdit(context: UserProfileToolContext, params: unknown): Promise<any> {
  const tool = createUserProfileEditTool(context);
  return await (tool.execute as any)("test-call", params);
}

// ---------------------------------------------------------------------------
// #10 / #14 — lookup scope
// ---------------------------------------------------------------------------

test("#10: file planted in users/notes/ with matching frontmatter is NOT returned", async () => {
  await withWorkspace(async (workspace) => {
    // Plant a malicious file outside `users/matrix/`.
    await mkdir(path.join(workspace, "users", "notes"), { recursive: true });
    await writeFile(
      path.join(workspace, "users", "notes", "me.md"),
      [
        "---",
        'provider: "matrix"',
        'sender_id: "@alice:example.org"',
        "aliases:",
        '  - "@alice:example.org"',
        'updated_at: "2026-01-01T00:00:00Z"',
        "version: 7",
        "---",
        "",
        "# Summary",
        "",
        "PLANTED MALICIOUS CONTENT",
      ].join("\n"),
      "utf8",
    );

    const context = buildContext({ workspaceRoot: workspace });
    const result = await runRead(context, { view: "exists" });

    // No profile should be returned — the planted file is outside `users/matrix/`.
    assert.equal(result.details.exists, false);
    // Canonical path falls back to the hashed default under users/matrix/.
    assert.match(result.details.path, /^\.\/users\/matrix\//);
  });
});

test("#10: file in users/matrix/ with matching frontmatter IS returned", async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(path.join(workspace, "users", "matrix"), { recursive: true });
    const profilePath = path.join(workspace, "users", "matrix", "alice-custom.md");
    await writeFile(
      profilePath,
      [
        "---",
        'provider: "matrix"',
        'sender_id: "@alice:example.org"',
        "aliases:",
        '  - "@alice:example.org"',
        'updated_at: "2026-01-01T00:00:00Z"',
        "version: 3",
        "---",
        "",
        "# Summary",
        "",
        "legitimate content",
      ].join("\n"),
      "utf8",
    );

    const context = buildContext({ workspaceRoot: workspace });
    const result = await runRead(context, { view: "exists" });

    assert.equal(result.details.exists, true);
    assert.equal(result.details.path, "./users/matrix/alice-custom.md");
  });
});

test("#10/#14: file in users/matrix/sub/ (deeper than direct children) is NOT returned", async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(path.join(workspace, "users", "matrix", "sub"), { recursive: true });
    await writeFile(
      path.join(workspace, "users", "matrix", "sub", "user.md"),
      [
        "---",
        'provider: "matrix"',
        'sender_id: "@alice:example.org"',
        "aliases:",
        '  - "@alice:example.org"',
        'updated_at: "2026-01-01T00:00:00Z"',
        "version: 9",
        "---",
        "",
        "# Summary",
        "",
        "deep content",
      ].join("\n"),
      "utf8",
    );

    const context = buildContext({ workspaceRoot: workspace });
    const result = await runRead(context, { view: "exists" });

    assert.equal(result.details.exists, false);
  });
});

// ---------------------------------------------------------------------------
// #11 / #25 — concurrent edits + version bump
// ---------------------------------------------------------------------------

test("#11: concurrent edits to the same profile do not lose data and version bumps monotonically", async () => {
  await withWorkspace(async (workspace) => {
    const context = buildContext({ workspaceRoot: workspace });

    // Seed an existing profile so we have a known initial version.
    await runEdit(context, {
      operations: [{ op: "replace_section", section: "Summary", text: "initial" }],
    });

    // Read back the initial version.
    const initial = await runRead(context, { view: "exists" });
    const initialVersion = initial.details.metadata.version as number;
    assert.equal(initialVersion, 1, "initial save should produce version 1");

    // Kick off two concurrent edits to DIFFERENT sections — both writes must
    // land. With no lock, the second writer would clobber the first writer's
    // change because each operation is a full read-modify-write.
    const [a, b] = await Promise.all([
      runEdit(context, {
        operations: [{ op: "replace_section", section: "Likes", text: "coffee" }],
      }),
      runEdit(context, {
        operations: [{ op: "replace_section", section: "Dislikes", text: "spam" }],
      }),
    ]);

    // Both calls completed successfully.
    assert.ok(a, "first concurrent edit returned");
    assert.ok(b, "second concurrent edit returned");

    // Both sections must be present.
    const finalLikes = await runRead(context, { view: "excerpt", section: "Likes" });
    const finalDislikes = await runRead(context, { view: "excerpt", section: "Dislikes" });
    assert.equal(finalLikes.details.text, "coffee");
    assert.equal(finalDislikes.details.text, "spam");

    // Version bumped by exactly 2 (initial + two concurrent edits).
    const finalState = await runRead(context, { view: "exists" });
    assert.equal(finalState.details.metadata.version, initialVersion + 2);
  });
});

// ---------------------------------------------------------------------------
// #15 — section body escape + section-name validation
// ---------------------------------------------------------------------------

test("#15: a section body containing '# Heading' round-trips correctly through write→read", async () => {
  await withWorkspace(async (workspace) => {
    const context = buildContext({ workspaceRoot: workspace });
    const tricky = "Some leading text.\n\n# Heading inside body\n\nMore text after.";

    await runEdit(context, {
      operations: [{ op: "replace_section", section: "Summary", text: tricky }],
    });

    // Read the section back via excerpt — content should be unchanged.
    const result = await runRead(context, { view: "excerpt", section: "Summary" });
    assert.equal(result.details.text, tricky);

    // And the structure on disk must not have promoted the body line into a
    // new section: the "Likes" section (a default) must still be present and
    // empty, not consumed by the embedded heading.
    const summary = await runRead(context, { view: "summary" });
    const sectionNames = (summary.details.sections as Array<{ name: string }>).map((s) => s.name);
    assert.ok(sectionNames.includes("Summary"));
    assert.ok(sectionNames.includes("Likes"));
    // Crucially, "Heading inside body" must NOT show up as a section.
    assert.ok(!sectionNames.includes("Heading inside body"));
  });
});

test("#15: a section name containing a newline is rejected", async () => {
  await withWorkspace(async (workspace) => {
    const context = buildContext({ workspaceRoot: workspace });
    await assert.rejects(
      () =>
        runEdit(context, {
          operations: [{ op: "replace_section", section: "Bad\nName", text: "x" }],
        }),
      /newline/i,
    );
  });
});

test("#15: a section name containing '#' is rejected", async () => {
  await withWorkspace(async (workspace) => {
    const context = buildContext({ workspaceRoot: workspace });
    await assert.rejects(
      () =>
        runEdit(context, {
          operations: [{ op: "replace_section", section: "Bad#Name", text: "x" }],
        }),
      /#/,
    );
  });
});

// ---------------------------------------------------------------------------
// A — allow_cross_user_targets config flag
// ---------------------------------------------------------------------------

test("A: with allow_cross_user_targets=false, explicit cross-user target is rejected", async () => {
  await withWorkspace(async (workspace) => {
    const context = buildContext({
      workspaceRoot: workspace,
      provider: "matrix",
      senderId: "@alice:example.org",
      config: { allow_cross_user_targets: false },
    });
    await assert.rejects(
      () =>
        runRead(context, {
          target: { mode: "explicit", provider: "matrix", senderId: "@mallory:example.org" },
          view: "exists",
        }),
      /cross-user/i,
    );
  });
});

test("A: with allow_cross_user_targets=false, explicit SAME-user target is allowed", async () => {
  await withWorkspace(async (workspace) => {
    const context = buildContext({
      workspaceRoot: workspace,
      provider: "matrix",
      senderId: "@alice:example.org",
      config: { allow_cross_user_targets: false },
    });
    // Explicit target that matches trigger sender — should be allowed.
    const result = await runRead(context, {
      target: { mode: "explicit", provider: "matrix", senderId: "@alice:example.org" },
      view: "exists",
    });
    assert.equal(result.details.exists, false); // no profile written yet, but call succeeded
  });
});

test("A: with allow_cross_user_targets=true (default), explicit cross-user target is allowed", async () => {
  await withWorkspace(async (workspace) => {
    const context = buildContext({
      workspaceRoot: workspace,
      provider: "matrix",
      senderId: "@alice:example.org",
      // No allow_cross_user_targets override → defaults to true.
    });
    const result = await runRead(context, {
      target: { mode: "explicit", provider: "matrix", senderId: "@mallory:example.org" },
      view: "exists",
    });
    // The call succeeds; profile simply doesn't exist yet.
    assert.equal(result.details.exists, false);
    assert.equal(result.details.target.senderId, "@mallory:example.org");
  });
});

test("A: requester-mode target is always allowed even when cross-user is disabled", async () => {
  await withWorkspace(async (workspace) => {
    const context = buildContext({
      workspaceRoot: workspace,
      config: { allow_cross_user_targets: false },
    });
    const result = await runRead(context, { view: "exists" }); // implicit requester mode
    assert.equal(result.details.target.senderId, "@alice:example.org");
  });
});
