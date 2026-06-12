import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { Storage, LATEST_SCHEMA_VERSION, type LinkPreviewRow } from "../src/storage/index.js";
import { linkPreviewRowToMeta } from "../src/context/hydrate.js";
import type { XTweetPayload } from "../src/fxtwitter/types.js";
import type { CanonicalChatEvent } from "../src/types.js";
import { TimelineStore } from "../src/timeline/index.js";

const PAYLOAD: XTweetPayload = {
  v: 1,
  tweet: {
    id: "111",
    authorName: "Frieren Daily",
    authorHandle: "frieren",
    text: "Tweet text",
    stats: { likes: 4521 },
    media: [{ assetId: "asset-1", kind: "mosaic", photoCount: 4 }],
  },
};

function chatEvent(): CanonicalChatEvent {
  return {
    id: "matrix:miku:$msg",
    externalId: "$msg",
    timelineKey: "matrix:miku:room:!room:example.org",
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org" },
    body: "https://x.com/frieren/status/111",
    timestamp: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
  };
}

test("payload_json round-trips through persistEnrichmentResults / getEnrichmentData / hydration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fxtw-storage-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    const timeline = new TimelineStore(storage);
    await timeline.append(chatEvent());

    const preview: LinkPreviewRow = {
      id: "lp-1",
      event_id: "matrix:miku:$msg",
      context: "message",
      url: "https://x.com/frieren/status/111",
      title: "Frieren Daily (@frieren)",
      description: "Frieren Daily (@frieren)\nTweet text",
      site_name: "X",
      source_kind: "fx_twitter",
      preview_index: 0,
      fetched_at: 1_700_000_001_000,
      fetch_status: "complete",
      payload_json: JSON.stringify(PAYLOAD),
      created_at: 1_700_000_001_000,
    };
    await storage.persistEnrichmentResults("matrix:miku:$msg", {
      replyContext: null,
      linkPreviews: [preview],
      mediaAssets: [{
        id: "asset-1",
        event_id: "matrix:miku:$msg",
        role: "preview_media",
        link_preview_id: "lp-1",
        media_type: "image",
        local_path: "msg-attach/m.jpg",
        download_status: "complete",
        caption_status: "pending",
        created_at: 1_700_000_001_000,
      }],
    });

    const data = storage.getEnrichmentData(["matrix:miku:$msg"]);
    const row = data.linkPreviews.get("matrix:miku:$msg")?.[0];
    assert.ok(row, "preview row read back");
    assert.equal(row.source_kind, "fx_twitter");
    assert.deepEqual(JSON.parse(row.payload_json!), PAYLOAD);

    const meta = linkPreviewRowToMeta(row, data.mediaAssets.get("matrix:miku:$msg") ?? []);
    assert.deepEqual(meta.payload, PAYLOAD, "hydration parses the payload");
    assert.equal(meta.media?.[0].id, "asset-1", "asset↔slot id mapping survives");
    assert.equal(meta.media?.[0].id, PAYLOAD.tweet.media![0].assetId);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("hydration tolerates a malformed payload_json (falls back to flat rendering)", async () => {
  const row: LinkPreviewRow = {
    id: "lp-1",
    event_id: "e1",
    context: "message",
    url: "https://x.com/a/status/1",
    source_kind: "fx_twitter",
    preview_index: 0,
    fetch_status: "complete",
    payload_json: "{not json",
    created_at: 0,
  };
  const meta = linkPreviewRowToMeta(row, []);
  assert.equal(meta.payload, undefined);
});

test("v18 -> v19 ALTER adds payload_json to a legacy link_previews with rows intact", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fxtw-migrate-"));
  const dbPath = path.join(dir, "legacy.db");
  try {
    const legacy = new Database(dbPath);
    legacy.exec(`create table timeline_events (
      id text primary key,
      external_id text,
      timeline_key text not null,
      provider text not null,
      role text not null check(role in ('user', 'assistant')),
      sender_id text not null,
      sender_display_name text,
      body text not null,
      timestamp integer not null,
      received_at integer not null,
      agent_session_id text,
      event_json text not null,
      enrichment_status text not null default 'pending'
        check(enrichment_status in ('inactive', 'pending', 'processing', 'complete', 'failed', 'skipped')),
      enrichment_retries integer not null default 0,
      redecrypt_attempts integer not null default 0,
      last_edit_timestamp integer,
      trigger_group_id text,
      created_at integer not null,
      updated_at integer not null,
      is_undecryptable integer generated always as
        (case when json_extract(event_json, '$.undecryptable') is not null then 1 else 0 end) virtual
    );`);
    // The v18 link_previews shape: no payload_json column.
    legacy.exec(`create table link_previews (
      id text primary key,
      event_id text not null references timeline_events(id) on delete cascade,
      context text not null,
      url text not null,
      title text,
      description text,
      site_name text,
      source_kind text,
      preview_index integer not null,
      fetched_at integer,
      fetch_status text not null,
      error text,
      created_at integer not null
    );`);
    legacy.prepare(
      `insert into timeline_events (id, timeline_key, provider, role, sender_id, body, timestamp, received_at, event_json, created_at, updated_at)
       values ('e1', 'tk', 'matrix', 'user', '@a:b', 'body', 1, 1, '{}', 1, 1)`,
    ).run();
    legacy.prepare(
      `insert into link_previews (id, event_id, context, url, preview_index, fetch_status, created_at)
       values ('lp-legacy', 'e1', 'message', 'https://example.com', 0, 'complete', 1)`,
    ).run();
    legacy.pragma("user_version = 18");
    legacy.close();

    const storage = await Storage.open({ databasePath: dbPath });
    try {
      const version = storage.read((db) => db.pragma("user_version", { simple: true }) as number);
      assert.equal(version, LATEST_SCHEMA_VERSION);
      const data = storage.getEnrichmentData(["e1"]);
      const row = data.linkPreviews.get("e1")?.[0];
      assert.ok(row, "legacy row survives");
      assert.equal(row.url, "https://example.com");
      assert.equal(row.payload_json ?? null, null, "legacy rows backfill to NULL");
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
