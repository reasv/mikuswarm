/**
 * Deleted messages in what a session sees (ARCHITECTURE.md §6 "Message edits",
 * §8 "Context tiers"): the rich and compact tiers, a level-1 summary's input and
 * reply quotes show a deleted message as a placeholder (position, sender, that
 * it was deleted, by whom when a moderator), never its content; search keeps it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ContextBuilder } from "../src/context/builder.js";
import { renderCompactMessage, renderRichMessage } from "../src/context/renderer.js";
import { ChatSearchIndexer } from "../src/search/index.js";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { createSearchMessagesTool } from "../src/tools/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import type { WorkspaceContent } from "../src/workspace/types.js";

const TK = "matrix:miku:room:!room";

function config(): AppConfig {
  return {
    app: { name: "test", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" },
    agent: { sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 }, system: {} },
    models: {
      default: {
        id: "test-model",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "key",
        input_modalities: ["text"],
        max_tokens: 4096,
        context_window: 128_000,
      },
    },
    // A small rich tier, so the older messages render compact.
    context: { tiers: { rich_target_tokens: 120, rich_max_tokens: 160, compact_target_tokens: 4000, compact_max_tokens: 8000 } },
    summarization: { enabled: false },
    storage: { database_path: ":memory:" },
    workspace: { root_dir: "/tmp" },
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
  } as AppConfig;
}

const workspace: WorkspaceContent = { files: new Map(), tailContent: null, skills: { listed: [], inlined: [] } };

function event(id: string, body: string, ts: number, sender = "@bob:x"): CanonicalChatEvent {
  return {
    id,
    externalId: `$${id}`,
    timelineKey: TK,
    provider: "matrix",
    role: "user",
    sender: { id: sender, displayName: sender.slice(1, sender.indexOf(":")) },
    body,
    timestamp: ts,
    receivedAt: ts,
  };
}

async function setup() {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config(), storage);
  await timeline.append(event("old-secret", "the old secret plan", 1_000));
  for (let i = 0; i < 6; i += 1) await timeline.append(event(`filler${i}`, `ordinary chat line number ${i} with some words`, 2_000 + i * 100));
  await timeline.append({
    ...event("img-secret", "look at this", 3_000),
    attachments: [{ id: "att-1", mediaType: "image", filename: "secret.png", caption: "a photo of the secret" }],
  });
  await timeline.append(event("mod-secret", "the moderated secret", 3_100, "@carol:x"));
  const reply = event("reply", "replying to that", 3_200, "@dave:x");
  reply.replyTo = { externalId: "$mod-secret" };
  await timeline.append(reply);
  await storage.insertReplyContext({
    event_id: "reply",
    reply_external_id: "$mod-secret",
    sender_id: "@carol:x",
    sender_display_name: "carol",
    body: "the moderated secret",
    timestamp: 3_100,
    created_at: 0,
  });
  await timeline.append(event("late-secret", "the latest secret", 3_300, "@erin:x"));
  const trigger = event("t", "what did I miss?", 5_000, "@alice:x");
  trigger.trigger = { type: "mention", reason: "mention", triggeredBy: trigger.sender, groupedEventIds: ["t"] };
  trigger.replyTo = { externalId: "$late-secret" };
  await timeline.append(trigger);
  await storage.insertReplyContext({
    event_id: "t",
    reply_external_id: "$late-secret",
    sender_id: "@erin:x",
    sender_display_name: "erin",
    body: "the latest secret",
    timestamp: 3_300,
    created_at: 0,
  });

  await storage.markTimelineEventDeleted("matrix", "$old-secret", TK, { at: 4_000 });
  await storage.markTimelineEventDeleted("matrix", "$img-secret", TK, { at: 4_100, by: "@bob:x" });
  await storage.markTimelineEventDeleted("matrix", "$mod-secret", TK, { at: 4_200, by: "@mod:x" });
  await storage.markTimelineEventDeleted("matrix", "$late-secret", TK, { at: 4_300, by: "@erin:x" });
  return { storage, timeline, builder, trigger };
}

function text(built: Awaited<ReturnType<ContextBuilder["build"]>>): string {
  return built.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
}

test("the next session's tiers show a deleted message as a placeholder, never its content", async () => {
  const { storage, builder, trigger } = await setup();
  try {
    const built = await builder.build({ timelineKey: TK, trigger, activeSessions: [], workspace, selfSessionId: "s1" });
    const all = text(built);
    for (const secret of ["old secret plan", "secret.png", "a photo of the secret", "the moderated secret", "the latest secret"]) {
      assert.ok(!all.includes(secret), `deleted content never shows: ${secret}`);
    }
    // Compact tier: the sender and the placeholder; a moderator is named, the
    // sender's own deletion names no deleter.
    assert.match(all, /\] bob \(@bob:x\): \[message deleted\]\n/);
    assert.match(all, /\] carol \(@carol:x\): \[message deleted by @mod:x\]\n/);
    // Rich tier: the envelope (sender, time, id) and the placeholder.
    assert.match(all, /<message sender="@erin:x" display_name="erin" time="[^"]+" external_id="\$late-secret">\n\[message deleted\]\n<\/message>/);
    // A quote of a deleted message shows the placeholder: compact, and rich (the
    // trigger's own quote in the final turn).
    assert.ok(all.includes("(Replying to: > [From: carol (@carol:x) At: 1970-01-01 00:00]: [message deleted by @mod:x])"));
    assert.match(all, /<reply_to sender="@erin:x" display_name="erin" time="[^"]+" external_id="\$late-secret">\n\[message deleted\]\n<\/reply_to>\n\nwhat did I miss\?/);
    assert.ok(all.includes("replying to that"), "the reply itself shows");
    assert.ok(built.compactTokens > 0 && built.richTokens > 0, "both tiers are in use");
  } finally {
    storage.close();
  }
});

test("a level-1 summary generated after the deletion renders the placeholder, and still covers the message", async () => {
  const { storage, builder, trigger } = await setup();
  try {
    const built = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace,
      selfSessionId: "sum",
      summarizationCutoff: { endTimestamp: 3_200 },
    });
    const all = text(built);
    assert.ok(!all.includes("old secret plan") && !all.includes("the moderated secret"));
    assert.ok(all.includes("[message deleted]"));
    assert.ok(built.renderedInputIds?.includes("old-secret"), "the deleted message is part of the summarized range");
  } finally {
    storage.close();
  }
});

test("search and the shared renderers still show a deleted message's stored content", async () => {
  const { storage } = await setup();
  try {
    const indexer = new ChatSearchIndexer({ storage });
    await indexer.reconcileAll();
    const tool = createSearchMessagesTool({ storage, indexer, currentTimelineKey: TK });
    const res = await tool.execute("t1", { query: "moderated", format: "compact" });
    const out = (res.content[0] as { type: "text"; text: string }).text;
    assert.ok(out.includes("the moderated secret"), "search finds and shows the deleted message");
    const stored = storage.getTimelineEventById("mod-secret")!;
    assert.ok(renderCompactMessage(stored).includes("the moderated secret"));
    assert.ok(renderRichMessage(stored).includes("the moderated secret"));
  } finally {
    storage.close();
  }
});

test("deleting an already-summarized message changes no summary: it is kept, still selected, not re-queued", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = new TimelineStore(storage);
    const builder = new ContextBuilder(timeline, config(), storage);
    await timeline.append(event("s1", "the old secret plan", 1_000));
    await timeline.append(event("s2", "an ordinary reply", 1_100));
    const content = "Bob shared the old secret plan.";
    await storage.insertSummarizationJob({
      id: "job_1",
      timelineKey: TK,
      level: 1,
      inputStartId: "s1",
      inputEndId: "s2",
      inputTokenCount: 20,
      targetTokenCount: 10,
      maxRetries: 2,
    });
    await storage.insertSummaryWithLineage({
      id: "sum_1",
      timelineKey: TK,
      level: 1,
      content,
      earliestTimestamp: 1_000,
      latestTimestamp: 1_100,
      latestEventId: "s2",
      eventCount: 2,
      tokenCount: 10,
      modelId: "test-model",
      status: "complete",
      generatedAt: 1,
      eventIds: ["s1", "s2"],
      jobId: "job_1",
    });
    const trigger = event("t", "hello", 5_000, "@alice:x");
    trigger.trigger = { type: "mention", reason: "mention", triggeredBy: trigger.sender, groupedEventIds: ["t"] };
    await timeline.append(trigger);
    const summaryRows = () => JSON.stringify(storage.read((db) => db.prepare("select * from summaries").all()));
    const jobRows = () => JSON.stringify(storage.read((db) => db.prepare("select * from summarization_jobs").all()));
    const before = summaryRows();
    const jobsBefore = jobRows();
    const builtBefore = await builder.build({ timelineKey: TK, trigger, activeSessions: [], workspace, selfSessionId: "a" });

    await storage.markTimelineEventDeleted("matrix", "$s1", TK, { at: 4_000 });

    assert.equal(summaryRows(), before, "the summary row is unchanged");
    assert.equal(jobRows(), jobsBefore, "no job is re-queued");
    const builtAfter = await builder.build({ timelineKey: TK, trigger, activeSessions: [], workspace, selfSessionId: "b" });
    assert.ok(text(builtAfter).includes(content), "the existing summary still renders as written");
    assert.equal(text(builtAfter), text(builtBefore), "deleting an already-summarized message makes no difference");
  } finally {
    storage.close();
  }
});

test("images of a deleted quoted message never become image blocks", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const timeline = new TimelineStore(storage);
    const builder = new ContextBuilder(timeline, config(), storage);
    await timeline.append(event("pic", "look", 1_000));
    const trigger = event("t", "what is this?", 2_000, "@alice:x");
    trigger.replyTo = { externalId: "$pic" };
    trigger.trigger = { type: "mention", reason: "mention", triggeredBy: trigger.sender, groupedEventIds: ["t"] };
    await timeline.append(trigger);
    await timeline.setTriggerGroup("t", ["t"]);
    await storage.insertMediaAsset({
      id: "t:reply:0",
      event_id: "t",
      role: "reply_attachment",
      media_type: "image",
      local_path: "/tmp/quoted.png",
      caption_status: "complete",
      download_status: "complete",
      created_at: 1_000,
    });
    const select = () =>
      (builder as unknown as { selectImageAttachments(t: CanonicalChatEvent): Array<{ attachment: { id: string } }> })
        .selectImageAttachments(trigger)
        .map((i) => i.attachment.id);
    assert.deepEqual(select(), ["t:reply:0"], "a live quoted image is a candidate");
    await storage.markTimelineEventDeleted("matrix", "$pic", TK, { at: 1_500 });
    assert.deepEqual(select(), [], "once the quoted message is deleted, its image is not");
  } finally {
    storage.close();
  }
});

for (const role of ["reply_linked_media", "reply_preview_media"]) {
  test(`${role} of a grouped member quoting a deleted message never becomes an image block`, async () => {
    const storage = await Storage.open({ databasePath: ":memory:" });
    try {
      const timeline = new TimelineStore(storage);
      const builder = new ContextBuilder(timeline, config(), storage);
      await timeline.append(event("pic", "see https://img.example/x.png", 1_000, "@bob:x"));
      const trigger = event("t", "what about this", 2_000, "@alice:x");
      trigger.trigger = { type: "mention", reason: "mention", triggeredBy: trigger.sender, groupedEventIds: ["t", "m2"] };
      await timeline.append(trigger);
      const member = event("m2", "and this one", 2_050, "@alice:x");
      member.replyTo = { externalId: "$pic" };
      await timeline.append(member);
      await timeline.setTriggerGroup("t", ["t", "m2"]);
      await storage.insertMediaAsset({
        id: "m2:quoted:0",
        event_id: "m2",
        role,
        media_type: "image",
        local_path: "/tmp/quoted.png",
        caption_status: "complete",
        download_status: "complete",
        created_at: 1_000,
      });
      const select = () =>
        (builder as unknown as { selectImageAttachments(t: CanonicalChatEvent): Array<{ attachment: { id: string } }> })
          .selectImageAttachments(trigger)
          .map((i) => i.attachment.id);
      assert.deepEqual(select(), ["m2:quoted:0"], "a live quoted message's media is a candidate");
      await storage.markTimelineEventDeleted("matrix", "$pic", TK, { at: 1_500 });
      assert.deepEqual(select(), [], "once the quoted message is deleted, its media is not");
    } finally {
      storage.close();
    }
  });
}
