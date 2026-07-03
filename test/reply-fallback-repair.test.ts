import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

// v2 → v3 repair migration for reply bodies over-stripped by the native
// reply-fallback stripper (strip_reply_fallback ate a fallback-less reply's own
// leading markdown-quote lines). The formatted body kept the content as a
// leading <blockquote>; the migration rebuilds the plain body from it.

const TK = "matrix:miku:room:!room";

function replyEvent(
  externalId: string,
  over: Partial<CanonicalChatEvent> = {},
): CanonicalChatEvent {
  return {
    id: `matrix:miku:${externalId}`,
    externalId,
    timelineKey: TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@user:example.org", displayName: "User", isSelf: false },
    body: "",
    timestamp: 1_000,
    receivedAt: 1_100,
    replyTo: { externalId: "$target" },
    ...over,
  };
}

function bodyOf(storage: Storage, id: string): { body: string; event_json: string } {
  return storage.read(
    (db) =>
      db.prepare(`select body, event_json from timeline_events where id = ?`).get(id) as {
        body: string;
        event_json: string;
      },
  );
}

test("v2→v3 migration rebuilds over-stripped reply quotes from the html blockquote", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-quote-repair-"));
  const dbPath = path.join(dir, "test.db");
  try {
    {
      const storage = await Storage.open({ databasePath: dbPath });
      const timeline = new TimelineStore(storage);

      // Whole-quote reply from a fallback-less client: the stripper emptied the
      // body; the entity-escaped quote survives only in the formatted body.
      await timeline.append(
        replyEvent("$emptied", {
          body: "",
          htmlBody: '<blockquote data-md="&gt;">how&#39;s it feel to know<br/></blockquote>',
        }),
      );
      // Quote + comment: only the leading quote lines were eaten.
      await timeline.append(
        replyEvent("$partial", {
          body: "major missed opportunity",
          htmlBody:
            "<blockquote><p>trap character<br/>not fleur</p></blockquote><p>major missed opportunity</p>",
        }),
      );
      // Undamaged reply from a fallback-sending client: the body still carries
      // the quote (only the real `> <@user> …` fallback was stripped) — no touch.
      await timeline.append(
        replyEvent("$intact", {
          body: "> deadguy shirt\n\nwow good taste",
          htmlBody: "<blockquote><p>deadguy shirt</p></blockquote><p>wow good taste</p>",
        }),
      );
      // Non-reply greentext was never stripped and must not be a candidate.
      await timeline.append(
        replyEvent("$plain", {
          body: ">implying",
          htmlBody: '<blockquote data-md="&gt;">implying<br/></blockquote>',
          replyTo: undefined,
        }),
      );
      // A nested blockquote can't be rebuilt reliably — left alone.
      await timeline.append(
        replyEvent("$nested", {
          body: "",
          htmlBody: "<blockquote>outer<blockquote>inner</blockquote></blockquote>",
        }),
      );

      await storage.write((db) => {
        // A later reply quoted the damaged $partial message; enrichment stored
        // the same stripped text as its reply context.
        db.prepare(
          `insert into reply_contexts (event_id, reply_external_id, sender_id, body, timestamp, created_at)
           values ('matrix:miku:$intact', '$partial', '@user:example.org', 'major missed opportunity', 1000, 0)`,
        ).run();
        // Re-stamp as v2 so the next open applies the v2→v3 step.
        db.pragma("user_version = 2");
      });
      storage.close();
    }

    const storage = await Storage.open({ databasePath: dbPath });
    try {
      const version = storage.read((db) => Number(db.pragma("user_version", { simple: true })));
      assert.equal(version, 3, "migration stamps v3");

      const emptied = bodyOf(storage, "matrix:miku:$emptied");
      assert.equal(emptied.body, "> how's it feel to know");
      assert.equal(
        (JSON.parse(emptied.event_json) as { body: string }).body,
        "> how's it feel to know",
        "event_json.body is rewritten alongside the column",
      );

      const partial = bodyOf(storage, "matrix:miku:$partial");
      assert.equal(partial.body, "> trap character\n> not fleur\n\nmajor missed opportunity");

      assert.equal(bodyOf(storage, "matrix:miku:$intact").body, "> deadguy shirt\n\nwow good taste");
      assert.equal(bodyOf(storage, "matrix:miku:$plain").body, ">implying");
      assert.equal(bodyOf(storage, "matrix:miku:$nested").body, "");

      const replyContext = storage.read(
        (db) =>
          db.prepare(`select body from reply_contexts where reply_external_id = '$partial'`).get() as {
            body: string;
          },
      );
      assert.equal(
        replyContext.body,
        "> trap character\n> not fleur\n\nmajor missed opportunity",
        "reply contexts quoting a repaired event get the repaired text",
      );
    } finally {
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
