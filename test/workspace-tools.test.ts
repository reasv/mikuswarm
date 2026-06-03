import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createSearchMemoryTool, createWriteMemoryTool } from "../src/tools/memory.js";
import { MemoryFileWriter } from "../src/storage/memory-writer.js";
import { createTextEditorTool, runRipgrep, runTextEditorCommand } from "../src/tools/file.js";
import { createReadImageTool } from "../src/tools/read-image.js";

test("text editor tool views, replaces, inserts, and creates within workspace", async () => {
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "notes/example.md",
      file_text: "alpha\nbeta\n",
    });

    const view = await runTextEditorCommand(workspace, {
      command: "view",
      path: "notes/example.md",
      view_range: [1, -1],
    });
    assert.equal(view.text, "1: alpha\n2: beta\n3: ");

    await runTextEditorCommand(workspace, {
      command: "str_replace",
      path: "notes/example.md",
      old_str: "beta",
      new_str: "gamma",
    });
    await runTextEditorCommand(workspace, {
      command: "insert",
      path: "notes/example.md",
      insert_line: 1,
      insert_text: "inserted",
    });

    assert.equal(await readFile(path.join(workspace, "notes/example.md"), "utf8"), "alpha\ninserted\ngamma\n");
  });
});

test("text editor rejects ambiguous replacements and workspace escapes", async () => {
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "ambiguous.txt",
      file_text: "same\nsame\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "ambiguous.txt",
          old_str: "same",
          new_str: "different",
        }),
      /more than once/,
    );
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "view",
          path: "../outside.txt",
        }),
      /escapes workspace/,
    );
  });
});

test("ripgrep search is scoped to the workspace", async () => {
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "src/a.txt",
      file_text: "needle\n",
    });
    const result = await runRipgrep(workspace, {
      pattern: "needle",
      path: ".",
      max_results: 10,
    });

    assert.match(result.text, /src\/a\.txt:1:needle/);
    await assert.rejects(
      () =>
        runRipgrep(workspace, {
          pattern: "needle",
          path: "..",
        }),
      /escapes workspace/,
    );
  });
});

test("workspace guard rejects symlink traversal outside workspace", async () => {
  await withWorkspace(async (workspace) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
      await symlink(outside, path.join(workspace, "linked-outside"), "dir");
      await mkdir(path.join(workspace, "safe"), { recursive: true });

      await assert.rejects(
        () =>
          runTextEditorCommand(workspace, {
            command: "view",
            path: "linked-outside/secret.txt",
          }),
        /escapes workspace/,
      );
      await assert.rejects(
        () =>
          runTextEditorCommand(workspace, {
            command: "create",
            path: "linked-outside/new.txt",
            file_text: "nope",
          }),
        /escapes workspace/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("daily memory editor is forced to memory/YYYY-MM-DD.md and memory search uses ripgrep", async () => {
  await withWorkspace(async (workspace) => {
    const editor = createWriteMemoryTool({
      workspaceRoot: workspace,
      memoryWriter: new MemoryFileWriter(workspace),
      now: new Date("2026-05-22T12:00:00.000Z"),
    });
    assert.equal(editor.name, "write_memory");
    await editor.execute("tool-1", {
      command: "insert",
      insert_line: 1,
      insert_text: "- remembered fact",
    });

    const memoryPath = path.join(workspace, "memory/2026-05-22.md");
    assert.equal(await readFile(memoryPath, "utf8"), "# 2026-05-22 Daily Memory\n- remembered fact\n");

    const search = createSearchMemoryTool({ workspaceRoot: workspace });
    const result = await search.execute("tool-2", {
      pattern: "remembered",
    });
    assert.match(result.content[0]?.text ?? "", /memory\/2026-05-22\.md:2:- remembered fact/);
  });
});

test("str_replace includes file contents in mismatch error", async () => {
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "hint.txt",
      file_text: "actual content here\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "hint.txt",
          old_str: "nonexistent text",
          new_str: "replacement",
        }),
      (err: Error) => {
        assert.match(err.message, /old_str was not found in hint\.txt/);
        assert.match(err.message, /actual content here/);
        return true;
      },
    );
  });
});

test("batch edits apply multiple replacements in one call", async () => {
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "batch.txt",
      file_text: "alpha\nbeta\ngamma\n",
    });
    const result = await runTextEditorCommand(workspace, {
      command: "str_replace",
      path: "batch.txt",
      edits: [
        { old_str: "alpha", new_str: "one" },
        { old_str: "beta", new_str: "two" },
        { old_str: "gamma", new_str: "three" },
      ],
    });
    assert.equal(result.details.replacements, 3);
    assert.equal(await readFile(path.join(workspace, "batch.txt"), "utf8"), "one\ntwo\nthree\n");
  });
});

test("batch edits fail on first mismatch with edit index", async () => {
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "batch-fail.txt",
      file_text: "alpha\nbeta\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "batch-fail.txt",
          edits: [
            { old_str: "alpha", new_str: "one" },
            { old_str: "missing", new_str: "two" },
          ],
        }),
      /edit 2\/2/,
    );
    // First edit should not have been persisted since we fail atomically
    assert.equal(await readFile(path.join(workspace, "batch-fail.txt"), "utf8"), "alpha\nbeta\n");
  });
});

test("mid-batch mismatch snippet shows original on-disk content, not post-edit state", async () => {
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "batch-snippet.txt",
      file_text: "alpha\nbeta\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "batch-snippet.txt",
          edits: [
            { old_str: "alpha", new_str: "one" },
            { old_str: "missing", new_str: "two" },
          ],
        }),
      (err: Error) => {
        // The snippet must reflect the ORIGINAL file (still contains "alpha"),
        // not the in-memory state after edit 1 applied (which would contain "one").
        assert.match(err.message, /alpha/);
        assert.ok(!err.message.includes("one\nbeta"), "snippet should not contain post-edit-1 state");
        return true;
      },
    );
  });
});

test("mismatch snippet is replaced with a hint for large files", async () => {
  await withWorkspace(async (workspace) => {
    // Build a file well over the 800-char MISMATCH_HINT_LIMIT.
    const big = "x".repeat(2000);
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "big-mismatch.txt",
      file_text: big,
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "big-mismatch.txt",
          old_str: "nope",
          new_str: "replacement",
        }),
      (err: Error) => {
        assert.match(err.message, /\[file is 2000 chars; call view to inspect\]/);
        // Must not include an 800-char dump of the file.
        assert.ok(!err.message.includes("x".repeat(800)), "should not include a positional dump");
        return true;
      },
    );
  });
});

test("str_replace rejects passing both edits and old_str", async () => {
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "both.txt",
      file_text: "alpha\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "both.txt",
          old_str: "alpha",
          new_str: "beta",
          edits: [{ old_str: "alpha", new_str: "gamma" }],
        }),
      /Pass either edits or old_str\/new_str, not both/,
    );
    // File must be unchanged.
    assert.equal(await readFile(path.join(workspace, "both.txt"), "utf8"), "alpha\n");
  });
});

test("str_replace rejects edits with both forms even when edits is empty", async () => {
  // Regression for #8: `edits` being defined is an explicit choice — passing
  // both forms must error regardless of `edits.length`. Previously an empty
  // `edits: []` was treated as "no batch present" and silently fell through to
  // the single-edit path, which was inconsistent.
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "both-empty.txt",
      file_text: "alpha\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "both-empty.txt",
          old_str: "alpha",
          new_str: "beta",
          edits: [],
        }),
      /Pass either edits or old_str\/new_str, not both/,
    );
    // File must be unchanged.
    assert.equal(await readFile(path.join(workspace, "both-empty.txt"), "utf8"), "alpha\n");
  });
});

test("str_replace rejects an empty edits array with a specific message", async () => {
  // Regression for #8: `edits: []` alone (no old_str/new_str) must produce a
  // specific error about the empty array, not the generic "requires old_str or
  // edits" message that pre-fix code threw.
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "empty-edits.txt",
      file_text: "alpha\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "empty-edits.txt",
          edits: [],
        }),
      /edits must contain at least one edit/,
    );
    // File must be unchanged.
    assert.equal(await readFile(path.join(workspace, "empty-edits.txt"), "utf8"), "alpha\n");
  });
});

test("str_replace rejects empty old_str up front, not as a duplicate match", async () => {
  // Regression for #9: empty old_str used to fall through to the loop where
  // indexOf("") returned 0 twice and produced a misleading "matched more than
  // once" error. The fix is to reject it up front with a clear message.
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "empty-old.txt",
      file_text: "alpha\nbeta\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "empty-old.txt",
          old_str: "",
          new_str: "prefix",
        }),
      (err: Error) => {
        assert.match(err.message, /old_str must not be empty/);
        // The misleading dup-match message must NOT appear.
        assert.ok(!/matched more than once/.test(err.message), "must not surface the misleading dup-match error");
        return true;
      },
    );
    assert.equal(await readFile(path.join(workspace, "empty-old.txt"), "utf8"), "alpha\nbeta\n");
  });
});

test("str_replace rejects empty old_str inside an edits batch with an edit index", async () => {
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "empty-old-batch.txt",
      file_text: "alpha\nbeta\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "empty-old-batch.txt",
          edits: [
            { old_str: "alpha", new_str: "one" },
            { old_str: "", new_str: "X" },
          ],
        }),
      (err: Error) => {
        assert.match(err.message, /old_str must not be empty/);
        assert.match(err.message, /edit 2\/2/);
        return true;
      },
    );
    assert.equal(await readFile(path.join(workspace, "empty-old-batch.txt"), "utf8"), "alpha\nbeta\n");
  });
});

test("batch dup-match error hints at prior edits and shows in-progress buffer", async () => {
  // Regression for #10: when an earlier edit introduces a new occurrence of a
  // later edit's old_str, the dup-match error should (a) note that an earlier
  // edit may have caused the duplication, and (b) include a snippet of the
  // in-progress buffer (after prior edits applied) so the agent can see what
  // the file actually looks like at this point.
  await withWorkspace(async (workspace) => {
    // Original file has exactly one "target". Edit 1 introduces a second
    // "target". Edit 2's old_str="target" then matches twice in the buffer.
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "dup-after-edit.txt",
      file_text: "intro\nfoo\ntarget\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "dup-after-edit.txt",
          edits: [
            { old_str: "foo", new_str: "target" },
            { old_str: "target", new_str: "replaced" },
          ],
        }),
      (err: Error) => {
        assert.match(err.message, /old_str matched more than once/);
        assert.match(err.message, /edit 2\/2/);
        // Must mention that an earlier edit may have caused the duplication.
        assert.match(err.message, /earlier edit/i);
        // Must include the in-progress buffer (which by now contains TWO "target"s).
        assert.match(err.message, /Current file contents:/);
        const snippetIdx = err.message.indexOf("Current file contents:");
        const snippet = err.message.slice(snippetIdx);
        const targetCount = (snippet.match(/target/g) ?? []).length;
        assert.ok(targetCount >= 2, `snippet must show the in-progress buffer with both targets; got: ${snippet}`);
        return true;
      },
    );
    // File must be unchanged (all-or-nothing).
    assert.equal(await readFile(path.join(workspace, "dup-after-edit.txt"), "utf8"), "intro\nfoo\ntarget\n");
  });
});

test("single-edit dup-match error does not include the 'earlier edit' hint", async () => {
  // Sanity check: the prior-edit hint must only appear for batch edits with
  // i > 0, not for single-edit (or first-of-batch) calls.
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "dup-single.txt",
      file_text: "same\nsame\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "dup-single.txt",
          old_str: "same",
          new_str: "different",
        }),
      (err: Error) => {
        assert.match(err.message, /matched more than once/);
        assert.ok(!/earlier edit/i.test(err.message), "single-edit dup-match must not mention an earlier edit");
        return true;
      },
    );
  });
});

test("view throws a specific error when view_range.start is past end of file", async () => {
  // Regression for #18: previously selectLineRange let startLine > lines.length
  // through, then Math.min'd endLine down to lines.length, producing an
  // inconsistent { startLine: 100, endLine: 3 } range and a silently empty
  // body. The fix surfaces a clear error so the model can pick a valid range.
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "short.txt",
      file_text: "a\nb\nc\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "view",
          path: "short.txt",
          view_range: [100, -1],
        }),
      (err: Error) => {
        // Message must mention both the requested start and the file's actual
        // line count so the model can correct itself.
        assert.match(err.message, /view_range\.start \(100\) is past end of file \(4 lines\)/);
        return true;
      },
    );
  });
});

test("batch edits: swap-style transforms surface dup-match because edits chain", async () => {
  // Pins documented batch-edit semantics for #19: edits apply sequentially
  // against the in-progress buffer. Edit 1 (A→B) turns "AB" into "BB"; edit 2
  // (B→A) then sees two B's and dup-matches. A future change that silently
  // makes swap-style transforms "just work" without updating the tool
  // description would break this test.
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "swap.txt",
      file_text: "AB",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "swap.txt",
          edits: [
            { old_str: "A", new_str: "B" },
            { old_str: "B", new_str: "A" },
          ],
        }),
      (err: Error) => {
        assert.match(err.message, /old_str matched more than once/);
        assert.match(err.message, /edit 2\/2/);
        // The prior-edit hint must surface because an earlier edit caused the dup.
        assert.match(err.message, /earlier edit/i);
        return true;
      },
    );
    // All-or-nothing: file must be unchanged.
    assert.equal(await readFile(path.join(workspace, "swap.txt"), "utf8"), "AB");
  });
});

test("batch edits: cascading transforms (foo→bar→baz) dup-match because edit 2 sees both bars", async () => {
  // Companion to the swap test: pins that edit 2's match is computed against
  // the in-progress buffer (which now contains TWO "bar"s). This is the
  // documented behavior — a separate call or more context per match is needed.
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "cascade.txt",
      file_text: "foo bar",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "cascade.txt",
          edits: [
            { old_str: "foo", new_str: "bar" },
            { old_str: "bar", new_str: "baz" },
          ],
        }),
      (err: Error) => {
        assert.match(err.message, /old_str matched more than once/);
        assert.match(err.message, /edit 2\/2/);
        return true;
      },
    );
    assert.equal(await readFile(path.join(workspace, "cascade.txt"), "utf8"), "foo bar");
  });
});

test("str_replace mismatch error includes a CRLF hint when the file is CRLF but old_str is LF", async () => {
  // Regression for #20: view splits on /\r?\n/ so what the model "saw" has no
  // \r, but str_replace is byte-exact. A multi-line LF old_str will silently
  // miss against a CRLF file. The hint prods the model to retry with \r\n.
  await withWorkspace(async (workspace) => {
    // Write CRLF directly via the underlying fs (the editor's `create` would
    // accept the string verbatim, but being explicit is clearer).
    await writeFile(path.join(workspace, "crlf.txt"), "alpha\r\nbeta\r\ngamma\r\n", "utf8");
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "crlf.txt",
          // LF-only old_str matching two lines — would match if the file were LF.
          old_str: "alpha\nbeta",
          new_str: "replaced",
        }),
      (err: Error) => {
        assert.match(err.message, /old_str was not found in crlf\.txt/);
        assert.match(err.message, /CRLF line endings/);
        assert.match(err.message, /include \\r\\n in old_str/);
        return true;
      },
    );
  });
});

test("str_replace mismatch error omits the CRLF hint for plain LF files", async () => {
  // Sanity check: the CRLF hint must NOT appear when the file is LF-only.
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "lf.txt",
      file_text: "alpha\nbeta\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "lf.txt",
          old_str: "nope",
          new_str: "x",
        }),
      (err: Error) => {
        assert.ok(!/CRLF/.test(err.message), "LF-only file must not surface a CRLF hint");
        return true;
      },
    );
  });
});

test("text editor tool declares executionMode: sequential", async () => {
  // Pins #D: str_replace mutates a file by index, so parallel str_replace
  // calls against the same file would race and lose writes silently. The tool
  // must flag itself as sequential so the agent runtime serializes calls.
  const tool = createTextEditorTool({ workspaceRoot: "/tmp/unused-for-metadata-check" });
  assert.equal(tool.executionMode, "sequential");
});

test("create reports a workspace-relative path in 'File already exists'", async () => {
  // Regression for #11: previously the error echoed the raw user-supplied path,
  // which was inconsistent with every other tool path that uses
  // workspaceRelative(). Path-shape may differ between callers (e.g. with or
  // without a leading "./") — the error should always report the relative form.
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "exists.txt",
      file_text: "original\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "create",
          // User supplies a path with a leading "./" — the error should still
          // report the canonical relative form "exists.txt".
          path: "./exists.txt",
          file_text: "second\n",
        }),
      (err: Error) => {
        assert.match(err.message, /^File already exists: exists\.txt$/);
        return true;
      },
    );
    // File must be unchanged.
    assert.equal(await readFile(path.join(workspace, "exists.txt"), "utf8"), "original\n");
  });
});

test("adaptive paging truncates large files with continuation hint", async () => {
  await withWorkspace(async (workspace) => {
    const bigContent = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "big.txt",
      file_text: bigContent,
    });
    // contextWindowTokens=80000 → fromContext = 80000*4*0.2 = 64000 chars,
    // which is above MIN_ADAPTIVE_BUDGET so resolveMaxCharacters returns
    // 64000. The file is ~78000 chars numbered, so this triggers truncation.
    const result = await runTextEditorCommand(
      workspace,
      { command: "view", path: "big.txt" },
      { contextWindowTokens: 80000 },
    );
    assert.match(result.text, /Use view_range to continue/);
    assert.equal(result.details.truncated, true);

    // The hint must declare an exact line range. Numbered lines look like
    // "<n>: line <n>"; we require:
    //   1. The hint references "Showing lines 1-<endLine>".
    //   2. <endLine> equals details.endLine (set to the last fully-visible line).
    //   3. <endLine> is strictly less than the file's line count (i.e. the
    //      hint does not overstate progress as the old off-by-one bug did).
    const hintMatch = result.text.match(/Showing lines (\d+)-(\d+)\. Use view_range to continue/);
    assert.ok(hintMatch, "expected exact line range in continuation hint");
    const hintStart = Number(hintMatch[1]);
    const hintEnd = Number(hintMatch[2]);
    assert.equal(hintStart, 1);
    assert.equal(hintEnd, result.details.endLine, "details.endLine must match hint last line");
    assert.ok(hintEnd < 5000, "hint must not claim to have shown the whole file");

    // The last visible line in the output must be exactly hintEnd — i.e. all
    // numbered lines through hintEnd appear in full, and hintEnd+1 does not.
    const expectedLastLine = `${hintEnd}: line ${hintEnd}`;
    assert.ok(result.text.includes(expectedLastLine), `expected last fully-visible line ${expectedLastLine}`);
    const overshootLine = `${hintEnd + 1}: line ${hintEnd + 1}`;
    assert.ok(!result.text.includes(overshootLine), `line ${hintEnd + 1} should not be fully visible`);
  });
});

test("adaptive paging trims mid-line fragments so visible region matches advertised range", async () => {
  // Regression: pre-fix, slicing at maxCharacters could leave a partial
  // "<N>: " prefix for the next line past the advertised last line, e.g.
  // "…3263: line 3263\n3264: " with hint "Showing lines 1-3263". The displayed
  // tail past the last \n must be stripped so the visible region matches the
  // advertised range exactly.
  await withWorkspace(async (workspace) => {
    const bigContent = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "midcut.txt",
      file_text: bigContent,
    });
    // Choose max_characters that lands in the middle of a numbered line.
    // Numbered lines are "1: line 1\n" (10 chars) ... "10: line 10\n" (12 chars).
    // 25 chars puts us mid-line at line 3 ("1: line 1\n2: line 2\n3: lin")
    // which has 2 newlines → completeLines=2 → lastVisibleLine=2.
    const result = await runTextEditorCommand(workspace, {
      command: "view",
      path: "midcut.txt",
      max_characters: 25,
    });
    assert.equal(result.details.truncated, true);
    assert.equal(result.details.endLine, 2, "endLine must be the last fully-visible line");
    // The dangling "3: lin" fragment must be removed from the visible body.
    // The text is everything up to the last \n, plus the continuation hint.
    // It must end with "2: line 2" (the last complete line) before the hint.
    assert.ok(
      result.text.includes("1: line 1\n2: line 2"),
      `expected complete lines 1-2 before truncation hint; got ${JSON.stringify(result.text)}`,
    );
    assert.ok(
      !result.text.includes("3: lin"),
      `partial line 3 fragment must be stripped; got ${JSON.stringify(result.text)}`,
    );
  });
});

test("adaptive paging handles max_characters too small to fit even one line", async () => {
  // Regression for #4: countLines previously returned startLine-1 when the
  // truncated prefix contained zero newlines, producing "Showing lines 1-0…"
  // and details.endLine < details.startLine. The fix is to floor endLine at
  // startLine and fall back to a plain [truncated] marker.
  await withWorkspace(async (workspace) => {
    const content = "first line that is reasonably long\nsecond\nthird\n";
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "tiny.txt",
      file_text: content,
    });
    const result = await runTextEditorCommand(workspace, {
      command: "view",
      path: "tiny.txt",
      max_characters: 1,
    });
    assert.equal(result.details.truncated, true);
    assert.equal(result.details.startLine, 1);
    // endLine floored at startLine — never less than startLine.
    assert.ok(
      result.details.endLine >= result.details.startLine,
      `endLine (${result.details.endLine}) must not be less than startLine (${result.details.startLine})`,
    );
    assert.equal(result.details.endLine, 1, "endLine should be floored at startLine for zero-complete-lines");
    // Should NOT emit a "Showing lines 1-0" hint. Should emit plain [truncated].
    assert.ok(
      !/Showing lines/.test(result.text),
      `must not advertise a line range when no complete line fits; got ${JSON.stringify(result.text)}`,
    );
    assert.match(result.text, /\[truncated\]/);
  });
});

test("adaptive paging: explicit view_range truncated by max_characters reports last visible line in details.endLine", async () => {
  // Regression for #6: pins the post-change semantics where an explicit
  // view_range=[1,N] truncated by max_characters reports details.endLine as
  // the last visible line, not the requested end.
  await withWorkspace(async (workspace) => {
    const bigContent = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "explicit-trunc.txt",
      file_text: bigContent,
    });
    // Request lines 1-100 but cap at 40 chars. Numbered lines: "1: line 1\n"
    // (10 chars), "2: line 2\n" (10 chars), "3: line 3\n" (10 chars),
    // "4: line 4\n" (10 chars) = 40 chars exactly, "5: line 5\n" (10 chars)
    // pushes total past 40 → truncates. 40 chars includes through line 4's
    // newline → completeLines=4, lastVisibleLine=4.
    const result = await runTextEditorCommand(workspace, {
      command: "view",
      path: "explicit-trunc.txt",
      view_range: [1, 100],
      max_characters: 40,
    });
    assert.equal(result.details.truncated, true);
    assert.equal(result.details.startLine, 1);
    // details.endLine must report the last visible line (4), NOT the requested
    // end (100). This is the new, intended semantics — pinned by this test.
    assert.equal(result.details.endLine, 4, "details.endLine must be the last visible line, not the requested end");
    // Explicit range gets a plain [truncated] marker (no "Use view_range to continue"
    // since the caller already chose a range).
    assert.match(result.text, /\[truncated\]/);
    assert.ok(!/Use view_range to continue/.test(result.text), "explicit range should not get continuation hint");
  });
});

test("adaptive paging respects small context windows instead of clamping to a floor", async () => {
  // Regression for #7: previously MIN_ADAPTIVE_BUDGET (50_000 chars ~ 12.5k
  // tokens) was applied as a hard floor regardless of context size, which
  // could blow a small model's entire context window on a single tool result.
  // The fix only applies the floor when fromContext * 2 >= MIN_ADAPTIVE_BUDGET.
  await withWorkspace(async (workspace) => {
    // Build a file whose numbered output is between fromContext and
    // MIN_ADAPTIVE_BUDGET so the floor's behavior is observable. At 10000
    // tokens, fromContext = 10000 * 4 * 0.2 = 8000 chars; the old behavior
    // would clamp to 50000, the new behavior keeps it at 8000.
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`);
    const bigContent = lines.join("\n");
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "small-context.txt",
      file_text: bigContent,
    });
    const result = await runTextEditorCommand(
      workspace,
      { command: "view", path: "small-context.txt" },
      { contextWindowTokens: 10000 },
    );
    assert.equal(result.details.truncated, true);
    // Strip the continuation hint to measure the visible body length.
    const bodyOnly = result.text.replace(/\n\[Showing lines [^\]]+\]$/, "").replace(/\n\[truncated\]$/, "");
    assert.ok(
      bodyOnly.length <= 8000,
      `body length (${bodyOnly.length}) must be capped at fromContext (8000) for a 10000-token model, not raised to MIN_ADAPTIVE_BUDGET`,
    );
    // Sanity: it should still emit some content (more than zero lines).
    assert.ok(result.details.endLine >= 1);
  });
});

test("adaptive paging does not affect explicit view_range", async () => {
  await withWorkspace(async (workspace) => {
    const bigContent = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "big2.txt",
      file_text: bigContent,
    });
    const result = await runTextEditorCommand(
      workspace,
      { command: "view", path: "big2.txt", view_range: [1, 5] },
      { contextWindowTokens: 10000 },
    );
    assert.ok(!result.text.includes("Use view_range to continue"));
    assert.equal(result.details.truncated, false);
  });
});

const TEST_MAX_IMAGE_BYTES = 3_932_160;

test("read_image returns image content block for valid image", async () => {
  await withWorkspace(async (workspace) => {
    // 1x1 red PNG
    const pngData = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(path.join(workspace, "test.png"), pngData);

    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    const result = await tool.execute("t1", { path: "test.png" });

    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, "text");
    assert.match((result.content[0] as { text: string }).text, /image\/png/);
    assert.equal(result.content[1].type, "image");
    const img = result.content[1] as { type: "image"; data: string; mimeType: string };
    assert.equal(img.mimeType, "image/png");
    assert.ok(img.data.length > 0);
  });
});

test("read_image rejects non-image files", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "notes.txt"), "hello", "utf8");
    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    await assert.rejects(
      () => tool.execute("t1", { path: "notes.txt" }),
      /Unsupported image format/,
    );
  });
});

test("read_image rejects workspace escape", async () => {
  await withWorkspace(async (workspace) => {
    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    await assert.rejects(
      () => tool.execute("t1", { path: "../outside.png" }),
      /escapes workspace/,
    );
  });
});

test("read_image rejects files whose base64 payload exceeds image_input_bytes", async () => {
  await withWorkspace(async (workspace) => {
    // The cap is measured against the base64-encoded payload, not raw bytes.
    // base64(N raw bytes) = 4 * ceil(N / 3). Pick a raw size that's safely
    // under the cap interpreted-as-raw but over the cap interpreted-as-base64.
    // limit = 4096 (base64), so the raw-byte budget is ceil(limit * 3 / 4) =
    // 3072. Writing 3100 raw bytes is under the old raw-byte check but over
    // the base64 check (4 * ceil(3100 / 3) = 4136 > 4096).
    const limit = 4096;
    const filePath = path.join(workspace, "huge.png");
    await writeFile(filePath, Buffer.alloc(3100));

    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: limit });
    await assert.rejects(
      () => tool.execute("t1", { path: "huge.png" }),
      /Image base64 size.*exceeds image_input_bytes/,
    );
  });
});

test("read_image accepts a file whose base64 payload is exactly at the cap", async () => {
  await withWorkspace(async (workspace) => {
    // base64(3 raw bytes) = 4. Build a real PNG, then derive the cap from its
    // actual size: cap = base64 size of the file's raw bytes. The check is
    // `base64(raw) > cap` so equality must pass.
    const pngBytes = await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
    }).png().toBuffer();
    await writeFile(path.join(workspace, "boundary.png"), pngBytes);
    const exactCap = 4 * Math.ceil(pngBytes.byteLength / 3);

    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: exactCap });
    const result = await tool.execute("t1", { path: "boundary.png" });
    assert.equal(result.content.length, 2);
    assert.equal((result.content[1] as { type: string }).type, "image");
  });
});

test("read_image refuses SVGs containing embedded data: URI rasters", async () => {
  await withWorkspace(async (workspace) => {
    // <image href="data:image/png;base64,..."> is decoded by librsvg against
    // the inner raster's own dimensions, so SVG_MAX_INPUT_PIXELS does not
    // bound it — a ~10 KB SVG can carry a gigapixel raster. Conservative
    // refusal: any data:image/... reference is rejected.
    const svgWithDataUri =
      `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect width="100" height="100" fill="blue"/>
  <image x="0" y="0" width="100" height="100" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="/>
</svg>`;
    await writeFile(path.join(workspace, "embed.svg"), svgWithDataUri, "utf8");

    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    await assert.rejects(
      () => tool.execute("t1", { path: "embed.svg" }),
      /embedded data: URI raster/,
    );

    // Also rejects xlink:href variant.
    const svgXlink =
      `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" width="100" height="100">
  <rect width="100" height="100" fill="blue"/>
  <image xlink:href="data:image/jpeg;base64,/9j/4AAQSkZJRg=="/>
</svg>`;
    await writeFile(path.join(workspace, "embed-xlink.svg"), svgXlink, "utf8");
    await assert.rejects(
      () => tool.execute("t1", { path: "embed-xlink.svg" }),
      /embedded data: URI raster/,
    );
  });
});

test("read_image still rasterizes plain SVGs without embedded data: URIs", async () => {
  // Boundary check for the embed gate — a vanilla SVG must still work.
  await withWorkspace(async (workspace) => {
    const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50" width="50" height="50">
  <circle cx="25" cy="25" r="20" fill="green"/>
</svg>`;
    await writeFile(path.join(workspace, "plain.svg"), svg, "utf8");
    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    const result = await tool.execute("t1", { path: "plain.svg" });
    assert.equal((result.content[1] as { type: string; mimeType: string }).mimeType, "image/png");
  });
});

test("read_image description does not direct the agent to web_fetch", async () => {
  // Documentation lock: web_fetch returns text/JSON, not raw image bytes the
  // read_image tool can attach. Description must not recommend it.
  const tool = createReadImageTool({ workspaceRoot: "/tmp", maxImageBytes: TEST_MAX_IMAGE_BYTES });
  assert.ok(typeof tool.description === "string");
  assert.equal(
    tool.description.includes("web_fetch"),
    false,
    `read_image description still mentions web_fetch: ${tool.description}`,
  );
});

test("read_image rejects non-regular files (e.g. directories)", async () => {
  await withWorkspace(async (workspace) => {
    // A directory named like an image file should be rejected by the isFile() check,
    // not read as if it were a regular file.
    await mkdir(path.join(workspace, "weird.png"));
    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    await assert.rejects(
      () => tool.execute("t1", { path: "weird.png" }),
      /Not a regular file/,
    );
  });
});

test("read_image rasterizes SVG to PNG", async () => {
  await withWorkspace(async (workspace) => {
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect width="100" height="100" fill="red" />
  <circle cx="50" cy="50" r="30" fill="blue" />
</svg>
`;
    await writeFile(path.join(workspace, "vector.svg"), svg, "utf8");

    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    const result = await tool.execute("t1", { path: "vector.svg" });

    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, "text");
    assert.match((result.content[0] as { text: string }).text, /image\/png/);
    assert.equal(result.content[1].type, "image");
    const img = result.content[1] as { type: "image"; data: string; mimeType: string };
    // SVG must be substituted for PNG — providers reject image/svg+xml.
    assert.equal(img.mimeType, "image/png");
    // Decoded payload should be a valid PNG (starts with the PNG magic bytes).
    const decoded = Buffer.from(img.data, "base64");
    assert.deepEqual(decoded.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});

test("read_image surfaces a clean error for malformed SVG", async () => {
  await withWorkspace(async (workspace) => {
    // Sniffs as SVG (starts with "<svg") but is structurally invalid XML —
    // forces the rasterizer to throw and exercise the catch path in
    // rasterizeSvgToPng.
    await writeFile(path.join(workspace, "broken.svg"), "<svg this is not valid xml", "utf8");
    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    await assert.rejects(
      () => tool.execute("t1", { path: "broken.svg" }),
      /Failed to rasterize SVG/,
    );
  });
});

test("read_image rejects files whose magic bytes don't match the extension", async () => {
  await withWorkspace(async (workspace) => {
    // JPEG magic bytes in a file named .png — providers would reject with an
    // opaque error; the tool should catch this up front.
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    await writeFile(path.join(workspace, "mislabeled.png"), jpegBytes);
    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    await assert.rejects(
      () => tool.execute("t1", { path: "mislabeled.png" }),
      /does not match extension/,
    );
  });
});

test("read_image rejects files whose bytes don't sniff as any supported format", async () => {
  await withWorkspace(async (workspace) => {
    // Plain text bytes in a file named .png — neither JPEG, PNG, GIF, WebP, nor SVG.
    await writeFile(path.join(workspace, "junk.png"), "hello world, not an image", "utf8");
    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    await assert.rejects(
      () => tool.execute("t1", { path: "junk.png" }),
      /Could not determine image format/,
    );
  });
});

test("read_image rejects SVGs whose rasterization would exceed the pixel budget", async () => {
  await withWorkspace(async (workspace) => {
    // Crafted SVG with a huge viewBox. At density=144 this would rasterize to
    // ~40000x40000 (~1.6 GP) — far past the 25 MP limitInputPixels budget; at
    // density=48 it would still be ~13000x13000 (~169 MP). All four densities
    // should hit the pixel cap and the fallback resize should also be refused.
    const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20000 20000" width="20000" height="20000"><rect width="20000" height="20000" fill="red"/></svg>`;
    await writeFile(path.join(workspace, "huge.svg"), svg, "utf8");
    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    await assert.rejects(
      () => tool.execute("t1", { path: "huge.svg" }),
      /too complex to rasterize/,
    );
  });
});

test("read_image rejects symlinks that escape the workspace", async () => {
  await withWorkspace(async (workspace) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-outside-img-"));
    try {
      // A real PNG sitting outside the workspace.
      const pngData = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
        "base64",
      );
      const realPng = path.join(outside, "secret.png");
      await writeFile(realPng, pngData);
      // Symlink inside the workspace pointing to the outside file.
      await symlink(realPng, path.join(workspace, "linked.png"), "file");

      const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
      await assert.rejects(
        () => tool.execute("t1", { path: "linked.png" }),
        /escapes workspace/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("read_image SVG rasterization does not follow file:// references (regression for librsvg sandbox)", async () => {
  // sharp + bundled librsvg should refuse to load external resources from
  // buffer-mode SVGs (no base URI → only data: URIs allowed). If a future
  // sharp/libvips upgrade regresses this behavior, this test catches it.
  // We construct an SVG that, IF the reference were followed, would paint a
  // 50x50 red square in the upper-left corner of the raster from the canary
  // PNG. We then assert the raster's top-left pixels are NOT pure red.
  await withWorkspace(async (workspace) => {
    const canaryDir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-svg-canary-"));
    try {
      // Build a 50x50 pure-red PNG using sharp directly.
      const canaryPng = await sharp({
        create: { width: 50, height: 50, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
      }).png().toBuffer();
      const canaryPath = path.join(canaryDir, "canary.png");
      await writeFile(canaryPath, canaryPng);

      // Two SVGs, both attempting to embed the canary via different reference
      // styles. The host background is pure blue (0,0,255) — if librsvg's
      // sandbox holds, the entire output is blue. If it leaks, the upper-left
      // 50x50 region becomes red.
      const svgs = [
        // file:// scheme with xlink:href (classic XXE-style image ref).
        `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" width="100" height="100">
  <rect width="100" height="100" fill="rgb(0,0,255)"/>
  <image x="0" y="0" width="50" height="50" xlink:href="file://${canaryPath}"/>
</svg>`,
        // file:// scheme with plain href (SVG 2 style).
        `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect width="100" height="100" fill="rgb(0,0,255)"/>
  <image x="0" y="0" width="50" height="50" href="file://${canaryPath}"/>
</svg>`,
      ];

      for (let idx = 0; idx < svgs.length; idx++) {
        const svgPath = path.join(workspace, `exfil-${idx}.svg`);
        await writeFile(svgPath, svgs[idx], "utf8");

        const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
        const result = await tool.execute("t1", { path: `exfil-${idx}.svg` });
        const img = result.content[1] as { type: "image"; data: string; mimeType: string };
        assert.equal(img.mimeType, "image/png");

        // Decode the rendered PNG back to raw pixels and count pure-red ones.
        // Even a partial leak would produce a meaningful count; a fully-blocked
        // load produces zero.
        const png = Buffer.from(img.data, "base64");
        const raw = await sharp(png).raw().toBuffer({ resolveWithObject: true });
        let redPixels = 0;
        const { data, info } = raw;
        for (let i = 0; i < data.length; i += info.channels) {
          if (data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 0) redPixels++;
        }
        assert.equal(
          redPixels,
          0,
          `SVG #${idx} leaked ${redPixels} red pixels — librsvg sandbox may have regressed; review and lock down before shipping`,
        );
      }
    } finally {
      await rm(canaryDir, { recursive: true, force: true });
    }
  });
});

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-workspace-"));
  try {
    await writeFile(path.join(workspace, ".keep"), "", "utf8");
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
