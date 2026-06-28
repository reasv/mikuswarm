import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage, type LinkPreviewRow } from "../src/storage/index.js";
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
