import assert from "node:assert/strict";
import test from "node:test";
import { renderRichMessage, renderCompactMessage } from "../src/context/renderer.js";
import type { CanonicalChatEvent, LinkPreviewMeta, AttachmentMeta } from "../src/types.js";
import type { XTweetPayload } from "../src/fxtwitter/types.js";

function chatEvent(overrides: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id: "matrix:miku:$msg",
    timelineKey: "matrix:miku:room:!room:example.org",
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body: "check this",
    timestamp: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function asset(overrides: Partial<AttachmentMeta> & { id: string }): AttachmentMeta {
  return {
    mediaType: "image",
    mimeType: "image/jpeg",
    localPath: `msg-attach/${overrides.id}.jpg`,
    processing: { downloaded: true, captioned: true },
    ...overrides,
  };
}

function xPreview(payload: XTweetPayload, media: AttachmentMeta[] = []): LinkPreviewMeta {
  return {
    url: "https://x.com/frieren/status/111",
    title: "Frieren Daily (@frieren)",
    description: "flat fallback text",
    sourceKind: "fx_twitter",
    media,
    payload,
  };
}

const BASE_PAYLOAD: XTweetPayload = {
  v: 1,
  tweet: {
    id: "111",
    authorName: "Frieren Daily",
    authorHandle: "frieren",
    createdAtMs: 1_760_000_000_000,
    text: "Tweet text here",
    stats: { replies: 12, retweets: 340, likes: 4521, views: 120034 },
  },
};

// ── Rich tier ────────────────────────────────────────────────────────────────

test("rich renderer emits the nested X structure with author/handle/stats", () => {
  const out = renderRichMessage(chatEvent({ linkPreviews: [xPreview(BASE_PAYLOAD)] }));
  assert.match(out, /<link_preview url="https:\/\/x\.com\/frieren\/status\/111" kind="x\.com">/);
  assert.match(out, /<tweet author="Frieren Daily" handle="@frieren" time="[^"]+" stats="12 replies · 340 retweets · 4,521 likes · 120,034 views">/);
  assert.match(out, /Tweet text here/);
  assert.ok(!out.includes("flat fallback text"), "payload branch does not emit the flat description");
});

test("rich renderer appends the x_fetch hint on truncated text", () => {
  const payload: XTweetPayload = {
    v: 1,
    tweet: { ...BASE_PAYLOAD.tweet, text: "cut…", textTruncated: true },
  };
  const out = renderRichMessage(chatEvent({ linkPreviews: [xPreview(payload)] }));
  assert.match(out, /cut…\n\[truncated — full text available via the x_fetch tool\]/);
});

test("rich renderer nests media inside the owning tweet node with captions and alt text", () => {
  const payload: XTweetPayload = {
    v: 1,
    tweet: {
      ...BASE_PAYLOAD.tweet,
      media: [{ assetId: "vid1", kind: "video", durationSeconds: 18 }],
      quote: {
        id: "999",
        authorName: "Other",
        authorHandle: "other",
        text: "Quoted text",
        media: [{ assetId: "mos1", kind: "mosaic", photoCount: 4, altText: "four cats" }],
      },
    },
  };
  const media = [
    asset({ id: "vid1", mediaType: "video", mimeType: "video/mp4", localPath: "msg-attach/v.mp4", caption: "An animated scene" }),
    asset({ id: "mos1", caption: "A four-panel collage", isImageBlock: true }),
  ];
  const out = renderRichMessage(chatEvent({ linkPreviews: [xPreview(payload, media)] }));

  assert.match(out, /<tweet_media kind="video" type="video\/mp4" duration="18s" path="msg-attach\/v\.mp4">\n\[caption: An animated scene\]\n<\/tweet_media>/);
  assert.match(out, /<quoted_tweet author="Other" handle="@other">/);
  assert.match(out, /<tweet_media kind="mosaic" photos="4" type="image\/jpeg" path="msg-attach\/mos1\.jpg" image_block="true">\n\[alt: four cats\]\n\[caption: A four-panel collage\]\n<\/tweet_media>/);
  // The mosaic tag must appear INSIDE the quoted_tweet block.
  const quoteStart = out.indexOf("<quoted_tweet");
  const quoteEnd = out.indexOf("</quoted_tweet>");
  const mosaicAt = out.indexOf('kind="mosaic"');
  assert.ok(quoteStart < mosaicAt && mosaicAt < quoteEnd, "quote media renders inside the quote node");
});

test("rich renderer indexes individual photos positionally", () => {
  const payload: XTweetPayload = {
    v: 1,
    tweet: {
      ...BASE_PAYLOAD.tweet,
      media: [
        { assetId: "p1", kind: "photo", index: 1 },
        { assetId: "p2", kind: "photo", index: 2, altText: "second" },
      ],
    },
  };
  const media = [asset({ id: "p1", caption: "first cap" }), asset({ id: "p2", caption: "second cap" })];
  const out = renderRichMessage(chatEvent({ linkPreviews: [xPreview(payload, media)] }));
  assert.match(out, /<tweet_media kind="photo" index="1\/2"[^>]*>\n\[caption: first cap\]/);
  assert.match(out, /<tweet_media kind="photo" index="2\/2"[^>]*>\n\[alt: second\]\n\[caption: second cap\]/);
});

test("rich renderer renders polls, community notes, and failed media slots", () => {
  const payload: XTweetPayload = {
    v: 1,
    tweet: {
      ...BASE_PAYLOAD.tweet,
      poll: {
        choices: [{ label: "Yes", percentage: 60 }, { label: "No", percentage: 40 }],
        totalVotes: 100,
      },
      communityNote: "Actually…",
      media: [{ assetId: "missing", kind: "video" }],
    },
  };
  const out = renderRichMessage(chatEvent({ linkPreviews: [xPreview(payload, [])] }));
  assert.match(out, /<poll total_votes="100">\nYes — 60%\nNo — 40%\n<\/poll>/);
  assert.match(out, /<community_note>\nActually…\n<\/community_note>/);
  assert.match(out, /<tweet_media kind="video" status="failed"\/>/, "failed slots are visible, not silent");
});

test("an fx_twitter preview without a payload falls back to the flat rendering", () => {
  const preview: LinkPreviewMeta = {
    url: "https://x.com/frieren/status/111",
    sourceKind: "fx_twitter",
    description: undefined,
  };
  const out = renderRichMessage(chatEvent({ linkPreviews: [preview] }));
  assert.match(out, /<link_preview url="https:\/\/x\.com\/frieren\/status\/111">/);
  assert.ok(!out.includes("<tweet"), "no structured branch without a payload");
});

// ── Compact tier ─────────────────────────────────────────────────────────────

test("compact tier renders the one-line tweet form with media counts", () => {
  const payload: XTweetPayload = {
    v: 1,
    tweet: {
      ...BASE_PAYLOAD.tweet,
      media: [{ assetId: "v1", kind: "video", durationSeconds: 18 }],
      quote: {
        id: "999",
        authorName: "Other Person",
        authorHandle: "other",
        text: "Quoted text",
        media: [{ assetId: "m1", kind: "mosaic", photoCount: 4 }],
      },
    },
  };
  const out = renderCompactMessage(chatEvent({ linkPreviews: [xPreview(payload)] }));
  assert.match(out, /\[tweet: Frieren Daily \(@frieren\): "Tweet text here" · 1 video \| quoting Other Person \(@other\): "Quoted text" · 4 photos\]/);
  assert.ok(!out.includes("120,034"), "stats dropped in compact");
  assert.ok(!out.includes("msg-attach"), "media paths dropped in compact");
});

test("compact tier includes media captions (with alt fallback and count fallback)", () => {
  const payload: XTweetPayload = {
    v: 1,
    tweet: {
      ...BASE_PAYLOAD.tweet,
      media: [
        { assetId: "v1", kind: "video", durationSeconds: 18 },
        { assetId: "p1", kind: "photo" }, // captioned
        { assetId: "p2", kind: "photo", altText: "alt only" }, // no caption → alt
        { assetId: "p3", kind: "photo" }, // no caption/alt → count fallback
      ],
      quote: {
        id: "999",
        authorName: "Other Person",
        authorHandle: "other",
        text: "Quoted text",
        media: [{ assetId: "m1", kind: "mosaic", photoCount: 4 }],
      },
    },
  };
  const media = [
    asset({ id: "v1", mediaType: "video", mimeType: "video/mp4", caption: "An animated scene" }),
    asset({ id: "p1", caption: "A close-up photo" }),
    asset({ id: "p2" }), // no caption
    asset({ id: "p3" }), // no caption
    asset({ id: "m1", caption: "A four-panel collage" }),
  ];
  const out = renderCompactMessage(chatEvent({ linkPreviews: [xPreview(payload, media)] }));
  assert.match(out, /video: An animated scene/);
  assert.match(out, /photo: A close-up photo/);
  assert.match(out, /photo: alt only/, "alt text used when no caption");
  assert.match(out, /· 1 photo\b/, "caption-less photo folds into the count form");
  assert.match(out, /mosaic\(4\): A four-panel collage/);
  assert.ok(!out.includes("msg-attach"), "media paths still dropped in compact");
});

test("compact tier marks failed tweet media as unavailable", () => {
  const payload: XTweetPayload = {
    v: 1,
    tweet: { ...BASE_PAYLOAD.tweet, media: [{ assetId: "x1", kind: "video" }] },
  };
  const media = [asset({ id: "x1", processing: { downloaded: false } })];
  const out = renderCompactMessage(chatEvent({ linkPreviews: [xPreview(payload, media)] }));
  assert.match(out, /video: \[media unavailable\]/);
});

test("compact tier bounds a tweet media caption at 200 chars", () => {
  const payload: XTweetPayload = {
    v: 1,
    tweet: { ...BASE_PAYLOAD.tweet, media: [{ assetId: "p1", kind: "photo" }] },
  };
  const media = [asset({ id: "p1", caption: "z".repeat(500) })];
  const out = renderCompactMessage(chatEvent({ linkPreviews: [xPreview(payload, media)] }));
  const m = /photo: (z+\.\.\.)/.exec(out);
  assert.ok(m, "caption present");
  assert.equal(m[1].length, 200);
});

test("compact tier truncates tweet text at 280 and quote text at 140 chars", () => {
  const payload: XTweetPayload = {
    v: 1,
    tweet: {
      ...BASE_PAYLOAD.tweet,
      text: "a".repeat(500),
      quote: { id: "999", authorName: "Other", authorHandle: "other", text: "b".repeat(500) },
    },
  };
  const out = renderCompactMessage(chatEvent({ linkPreviews: [xPreview(payload)] }));
  const main = /Frieren Daily \(@frieren\): "(a+\.\.\.)"/.exec(out);
  assert.ok(main, "main text present");
  assert.equal(main[1].length, 280);
  const quote = /quoting Other \(@other\): "(b+\.\.\.)"/.exec(out);
  assert.ok(quote, "quote text present");
  assert.equal(quote[1].length, 140);
});

test("compact reply context carries attachment captions and tweet previews", () => {
  const out = renderCompactMessage(chatEvent({
    replyTo: {
      sender: { id: "@bob:example.org", displayName: "Bob" },
      timestamp: 1_700_000_000_000,
      body: "look",
      attachments: [asset({ id: "r1", filename: "pic.jpg", caption: "a sunset" })],
      linkPreviews: [xPreview(BASE_PAYLOAD)],
    },
  }));
  assert.match(out, /Replying to:/);
  assert.match(out, /\[attachment: pic\.jpg [^\]]*caption=a sunset\]/);
  assert.match(out, /\[tweet: Frieren Daily \(@frieren\): "Tweet text here"\]/);
});

test("compact tier falls back to the generic [link:] form without a payload", () => {
  const preview: LinkPreviewMeta = {
    url: "https://x.com/frieren/status/111",
    title: "Frieren Daily (@frieren)",
    description: "flat text",
    sourceKind: "fx_twitter",
  };
  const out = renderCompactMessage(chatEvent({ linkPreviews: [preview] }));
  assert.match(out, /\[link: Frieren Daily \(@frieren\) — flat text\]/);
});

test("compact tier leaves non-X previews on the generic 1000-char form", () => {
  const preview: LinkPreviewMeta = {
    url: "https://example.com",
    title: "Example",
    description: "d".repeat(2000),
    sourceKind: "synapse",
  };
  const out = renderCompactMessage(chatEvent({ linkPreviews: [preview] }));
  const m = /\[link: Example — (d+\.\.\.)\]/.exec(out);
  assert.ok(m);
  assert.equal(m[1].length, 1000);
});
