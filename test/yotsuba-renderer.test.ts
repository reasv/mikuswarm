/**
 * Tests for src/context/renderer.ts — yotsuba (4chan) link preview renderings.
 * Covers spec §6.6 golden outputs A–H:
 *   A. Ambient thread link
 *   B. Ambient post link (untitled thread)
 *   C. Trigger thread link (all posts fit)
 *   D. Trigger thread link (crowded group: budget-trimmed)
 *   E. Trigger post link (reply context)
 *   F. Compact zone outputs
 *   G. Gone (404 at enrichment)
 *   H. Board link
 * Also covers discord_embed suppression and escaping.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { renderRichMessage, renderCompactMessage } from "../src/context/renderer.js";
import type { CanonicalChatEvent, LinkPreviewMeta, AttachmentMeta } from "../src/types.js";
import type { YotsubaPreviewPayload, YotsubaPostNode } from "../src/yotsuba/types.js";
import { YOTSUBA_SOURCE_KIND } from "../src/yotsuba/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

function imageAsset(id: string, localPath: string, caption?: string): AttachmentMeta {
  return {
    id,
    mediaType: "image",
    mimeType: "image/png",
    localPath,
    processing: { downloaded: true, captioned: caption !== undefined },
    caption,
  };
}

function yotsubaPreview(
  url: string,
  payload: YotsubaPreviewPayload,
  media: AttachmentMeta[] = [],
  fetchedAt?: number,
): LinkPreviewMeta {
  return {
    url,
    sourceKind: YOTSUBA_SOURCE_KIND,
    yotsubaPayload: payload,
    media,
    fetchedAt,
  };
}

// A fixed epoch for as_of that yields a stable timestamp string.
const AS_OF_MS = new Date("2026-09-29T02:10:00Z").getTime();

// A fixed post time for tests.
function postMs(timeStr: string): number {
  return new Date(timeStr + "Z").getTime();
}

// ---------------------------------------------------------------------------
// A. Ambient, thread link — OP shown, truncated at ambient_chars (300)
// ---------------------------------------------------------------------------

test("A: ambient thread link renders metadata and headline post", () => {
  const payload: YotsubaPreviewPayload = {
    v: 1,
    kind: "thread",
    board: "g",
    boardTitle: "Technology",
    asOf: AS_OF_MS,
    threadNo: 109930292,
    subject: "/lmg/ - Local Models General",
    postCount: 435,
    fileCount: 88,
    posters: 121,
    status: ["bump limit"],
    headlineNo: 109930292,
    posts: [
      {
        no: 109930292,
        index: 0,
        role: "op",
        time: postMs("2026-09-28T10:31:00"),
        text: "/lmg/ - a general dedicated to the discussion and development of local language models.\n\nPrevious threads: >>>/g/109925219 (other thread) & >>>/g/109921422 (other thread)\n\n►News\n>(09/26) koboldcpp-1.122 + bundled harness\n>(09/26) exllamav3 v1.5.2 with Turing support\n>(09/25) MiMo-V2.6-RL training dataset released\nA very long OP that continues here.",
        quotes: [],
        replies: 3,
        file: { name: "lmg", ext: ".png", w: 1024, h: 1024, bytes: 1_100_000, tim: 1727519460000 },
      },
    ],
  };

  const out = renderRichMessage(chatEvent({ linkPreviews: [yotsubaPreview("https://boards.4chan.org/g/thread/109930292", payload)] }));

  // Basic structure
  assert.match(out, /<link_preview url="https:\/\/boards\.4chan\.org\/g\/thread\/109930292" kind="4chan">/);
  assert.match(out, /board="\/g\/ - Technology"/);
  assert.match(out, /no="109930292"/);
  assert.match(out, /subject="\/lmg\/ - Local Models General"/);
  assert.match(out, /posts="435"/);
  assert.match(out, /files="88"/);
  assert.match(out, /posters="121"/);
  assert.match(out, /status="bump limit"/);
  // OP rendered with role="op"
  assert.match(out, /role="op"/);
  assert.match(out, /replies="3"/);
  // Ambient footer
  assert.match(out, /\[4chan: opening post only\. The yotsuba tool reads the thread\.\]/);
  // File shown as "not shown" (no assetId)
  assert.match(out, /status="not shown"/);
});

test("A: ambient thread link renders OP text from payload (no renderer-level truncation)", () => {
  // The renderer renders text as stored in payload; ambient_chars limiting is applied
  // during enrichment capture, not at render time. This test verifies the renderer
  // faithfully outputs whatever text is in the post node.
  const storedText = "x".repeat(300); // A realistic capture-limited text
  const payload: YotsubaPreviewPayload = {
    v: 1,
    kind: "thread",
    board: "g",
    boardTitle: "Technology",
    asOf: AS_OF_MS,
    threadNo: 100000,
    headlineNo: 100000,
    postCount: 10,
    posts: [
      { no: 100000, index: 0, role: "op", time: AS_OF_MS - 3600000, text: storedText, quotes: [], replies: 0 },
    ],
  };

  const out = renderRichMessage(chatEvent({ linkPreviews: [yotsubaPreview("https://boards.4chan.org/g/thread/100000", payload)] }));
  assert.match(out, /no="100000"/);
  assert.match(out, /role="op"/);
  // Text is present
  assert.ok(out.includes("x".repeat(100)));
});

// ---------------------------------------------------------------------------
// B. Ambient, post link — untitled thread shows op_excerpt
// ---------------------------------------------------------------------------

test("B: ambient post link shows linked post and op_excerpt for untitled thread", () => {
  const payload: YotsubaPreviewPayload = {
    v: 1,
    kind: "thread",
    board: "g",
    boardTitle: "Technology",
    asOf: AS_OF_MS,
    threadNo: 109933629,
    opExcerpt: "why does every linux distro installer still ask…",
    postCount: 54,
    fileCount: 7,
    linkedNo: 109934102,
    headlineNo: 109934102,
    posts: [
      {
        no: 109934102,
        index: 20,
        role: "linked",
        time: postMs("2026-09-29T01:40:00"),
        text: ">>109934055 (not shown)\nbecause the people who write installers are not the people who use installers",
        quotes: [109934055],
        replies: 5,
        file: { name: "calamares", ext: ".png", w: 800, h: 600, bytes: 96_000, tim: 1727569200000 },
      },
    ],
  };

  const out = renderRichMessage(chatEvent({
    linkPreviews: [yotsubaPreview("https://boards.4chan.org/g/thread/109933629#p109934102", payload)],
  }));

  // Thread tag carries op_excerpt (no subject)
  assert.match(out, /op_excerpt="why does every linux distro installer still ask/);
  // linked="..." on thread element
  assert.match(out, /linked="109934102"/);
  // Linked post rendered
  assert.match(out, /no="109934102"/);
  assert.match(out, /role="linked"/);
  // Quote annotation: >>109934055 not in shownNos → (not shown)
  assert.match(out, /109934055 \(not shown\)/);
  // Ambient footer for post link
  assert.match(out, /the linked post only/);
  assert.match(out, /yotsuba tool reads the thread and the conversation/);
});

// ---------------------------------------------------------------------------
// C. Trigger, thread link — all posts fit in budget
// ---------------------------------------------------------------------------

test("C: trigger thread link renders OP + replied-to + latest posts", () => {
  const assetId1 = "asset_lmg_png";
  const assetId2 = "asset_needle_png";
  const assetId3 = "asset_webm_storyboard";

  const upgrade = {
    triggerGroupId: "trig1",
    includedNos: [109930292, 109934410, 109935650, 109935841, 109935870, 109935902],
    processedAssetIds: [assetId1, assetId2, assetId3],
  };

  const posts: YotsubaPostNode[] = [
    {
      no: 109930292, index: 0, role: "op",
      time: postMs("2026-09-28T10:31:00"),
      text: "/lmg/ - a general dedicated to the discussion and development of local language models.\n\n►News\n>(09/26) koboldcpp-1.122",
      quotes: [], replies: 3,
      file: { name: "lmg", ext: ".png", w: 1024, h: 1024, bytes: 1_100_000, tim: 1000, assetId: assetId1 },
    },
    {
      no: 109934410, index: 200, role: "replied_to",
      time: postMs("2026-09-29T01:22:00"),
      text: "what's the actual context limit before it starts repeating itself",
      quotes: [], replies: 1,
    },
    {
      no: 109935650, index: 420, role: "replied_to",
      time: postMs("2026-09-29T02:01:00"),
      text: "is there any point running 70b dense anymore or is it all moe now",
      quotes: [], replies: 2,
    },
    {
      no: 109935841, index: 437, role: "latest",
      time: postMs("2026-09-29T02:06:00"),
      text: ">>109935650\ndense still wins on long context coherence desu",
      quotes: [109935650], replies: 1,
      file: { name: "needle", ext: ".png", w: 1400, h: 900, bytes: 140_000, tim: 2000, assetId: assetId2 },
    },
    {
      no: 109935870, index: 438, role: "latest",
      time: postMs("2026-09-29T02:07:00"),
      text: ">>109935841\nsource: my ass",
      quotes: [109935841], replies: 0,
    },
    {
      no: 109935902, index: 439, role: "latest",
      time: postMs("2026-09-29T02:09:00"),
      text: ">>109935650\n>>109934410\nmoe for chat, dense if you need it to remember what happened 20k tokens ago",
      quotes: [109935650, 109934410], replies: 0,
      file: { name: "1790650140221", ext: ".webm", durationSec: 14, bytes: 2_900_000, tim: 3000, assetId: "asset_webm", storyboardAssetId: assetId3 },
    },
  ];

  const media: AttachmentMeta[] = [
    imageAsset(assetId1, "msg-attach/k2m9x0q1zab3d.png", "An anime girl with teal twintails sitting at a desk with three GPUs and a llama plush."),
    imageAsset(assetId2, "msg-attach/p0x8c1v7ma2ke.png", "A line chart of needle-in-a-haystack accuracy against context length for four models."),
    { id: "asset_webm", mediaType: "video", mimeType: "video/webm", localPath: "msg-attach/w4n7s2k9dq0le.webm", processing: { downloaded: true, captioned: false } },
    imageAsset(assetId3, "msg-attach/b8r1c5m3xz7aa.jpg", "A cat knocks a glass off a table in slow motion while dramatic choir music plays."),
  ];

  const payload: YotsubaPreviewPayload = {
    v: 1, kind: "thread", board: "g", boardTitle: "Technology",
    asOf: AS_OF_MS, threadNo: 109930292,
    subject: "/lmg/ - Local Models General",
    postCount: 435, fileCount: 88, posters: 121,
    status: ["bump limit"],
    headlineNo: 109930292,
    posts,
    upgrade,
  };

  const out = renderRichMessage(chatEvent({
    linkPreviews: [yotsubaPreview("https://boards.4chan.org/g/thread/109930292", payload, media)],
  }));

  // All included posts rendered
  assert.match(out, /no="109930292"/);
  assert.match(out, /no="109934410"/);
  assert.match(out, /no="109935650"/);
  assert.match(out, /no="109935841"/);
  assert.match(out, /no="109935870"/);
  assert.match(out, /no="109935902"/);
  // OP file has image_block="true" and caption
  assert.match(out, /image_block="true"/);
  assert.match(out, /\[caption: An anime girl with teal twintails/);
  // Trigger footer mentions snapshot
  assert.match(out, /4chan thread snapshot/);
  assert.match(out, /opening post.*last 3 replies.*2 posts they answer/);
  // Quote annotations present in post text
  assert.match(out, /&gt;&gt;109935650/);
  assert.match(out, /109934410/);
});

// ---------------------------------------------------------------------------
// D. Trigger thread link — budget-trimmed (D is tested via drop logic)
// ---------------------------------------------------------------------------

test("D: trigger thread link with budget drop shows auto='off' for stored files", () => {
  const assetId1 = "op_asset";

  const upgrade = {
    triggerGroupId: "trig2",
    includedNos: [109930292, 109935870, 109935902],
    processedAssetIds: [],  // no processed files (budget used by prior links)
    left: { latest: 1, repliedTo: 2 },
  };

  const posts: YotsubaPostNode[] = [
    {
      no: 109930292, index: 0, role: "op",
      time: postMs("2026-09-28T10:31:00"),
      text: "OP text here",
      quotes: [], replies: 3,
      file: { name: "lmg", ext: ".png", w: 1024, h: 1024, bytes: 1_100_000, tim: 1000, assetId: assetId1 },
    },
    {
      no: 109935870, index: 438, role: "latest",
      time: postMs("2026-09-29T02:07:00"),
      text: ">>109935841 (not shown)\nsource: my ass",
      quotes: [109935841], replies: 0,
    },
    {
      no: 109935902, index: 439, role: "latest",
      time: postMs("2026-09-29T02:09:00"),
      text: ">>109935650 (not shown)\n>>109934410 (not shown)\nmoe for chat",
      quotes: [109935650, 109934410], replies: 0,
      file: { name: "1790650140221", ext: ".webm", bytes: 2_900_000, tim: 3000, assetId: "webm_asset" },
    },
  ];

  const media: AttachmentMeta[] = [
    imageAsset(assetId1, "msg-attach/lmg.png"),
    { id: "webm_asset", mediaType: "video", mimeType: "video/webm", localPath: "msg-attach/video.webm", processing: { downloaded: true, captioned: false } },
  ];

  const payload: YotsubaPreviewPayload = {
    v: 1, kind: "thread", board: "g", boardTitle: "Technology",
    asOf: AS_OF_MS, threadNo: 109930292,
    subject: "/lmg/ - Local Models General",
    postCount: 435, fileCount: 88,
    headlineNo: 109930292,
    posts,
    upgrade,
  };

  const out = renderRichMessage(chatEvent({
    linkPreviews: [yotsubaPreview("https://boards.4chan.org/g/thread/109930292", payload, media)],
  }));

  // auto="off" for stored files
  assert.match(out, /auto="off"/);
  // "left out for length" in footer
  assert.match(out, /left out for length/);
  assert.match(out, /1 more latest reply/);
  assert.match(out, /2 replied-to posts/);
  // File note in footer
  assert.match(out, /Files marked auto="off"/);
  assert.match(out, /open them by path with read_image or media/);
});

// ---------------------------------------------------------------------------
// E. Trigger post link in reply context
// ---------------------------------------------------------------------------

test("E: trigger post link shows linked post with replies and replied-to posts", () => {
  const fileAssetId = "context_rot_png";
  const presetAssetId = "preset_png";

  const upgrade = {
    triggerGroupId: "trig3",
    includedNos: [109931388, 109931402, 109931450, 109931461, 109931470, 109931502],
    processedAssetIds: [fileAssetId, presetAssetId],
  };

  const posts: YotsubaPostNode[] = [
    {
      no: 109931388, index: 100, role: "replied_to",
      time: postMs("2026-09-28T11:59:00"),
      text: "benchmarks mean nothing, show me it holding a coherent story past 8k",
      quotes: [], replies: 4,
    },
    {
      no: 109931402, index: 102, role: "replied_to",
      time: postMs("2026-09-28T12:00:00"),
      text: ">>109931377 (not shown)\n>38 t/s\nthat's with spec decoding off? post settings or it didn't happen",
      quotes: [109931377], deadQuotes: [], replies: 6,
      posterId: "Ab12Cd34", flag: "Finland",
    },
    {
      no: 109931450, index: 112, role: "linked",
      time: postMs("2026-09-28T12:04:00"),
      text: ">>109931388\n>>109931402\n>38 t/s on a 3090\nyeah and here is what it actually writes after 4k tokens",
      quotes: [109931388, 109931402], replies: 26,
      replyNos: [109931461, 109931470, 109931502],
      file: { name: "context_rot", ext: ".png", w: 1180, h: 2400, bytes: 612_000, tim: 4000, assetId: fileAssetId },
    },
    {
      no: 109931461, index: 113, role: "reply",
      time: postMs("2026-09-28T12:05:00"),
      text: ">>109931450\nskill issue, wrong chat template",
      quotes: [109931450], replies: 2,
    },
    {
      no: 109931470, index: 115, role: "reply",
      time: postMs("2026-09-28T12:05:00"),
      text: ">>109931450\n>shivers\nit's over",
      quotes: [109931450], replies: 0,
    },
    {
      no: 109931502, index: 125, role: "reply",
      time: postMs("2026-09-28T12:07:00"),
      text: ">>109931450\n>>109931455 (not shown)\nnta but his template is fine, the repetition penalty is off",
      quotes: [109931450, 109931455], replies: 1,
      file: { name: "preset", ext: ".png", w: 640, h: 480, bytes: 52_000, tim: 5000, assetId: presetAssetId },
    },
  ];

  const media: AttachmentMeta[] = [
    imageAsset(fileAssetId, "msg-attach/ab3kd92mx0q1z.png", "A screenshot of a chat log where a model's reply degrades into the word 'shivers' repeated dozens of times."),
    imageAsset(presetAssetId, "msg-attach/z9q2w8e7r6t5y.png", "A settings panel with the repetition penalty slider set to 1.0."),
  ];

  const payload: YotsubaPreviewPayload = {
    v: 1, kind: "thread", board: "g", boardTitle: "Technology",
    asOf: postMs("2026-09-28T12:20:00"),
    threadNo: 109930292, subject: "/lmg/ - Local Models General",
    opExcerpt: "/lmg/ - a general dedicated to the discussion…",
    postCount: 435, fileCount: 88, posters: 121, status: ["bump limit"],
    linkedNo: 109931450, headlineNo: 109931450,
    posts,
    upgrade,
  };

  const out = renderRichMessage(chatEvent({
    linkPreviews: [yotsubaPreview("https://boards.4chan.org/g/thread/109930292#p109931450", payload, media)],
  }));

  // All included posts
  assert.match(out, /no="109931388"/);
  assert.match(out, /no="109931402"/);
  assert.match(out, /no="109931450"/);
  assert.match(out, /no="109931461"/);
  assert.match(out, /no="109931470"/);
  assert.match(out, /no="109931502"/);
  // posterId and flag on 109931402
  assert.match(out, /id="Ab12Cd34"/);
  assert.match(out, /flag="Finland"/);
  // linked post's image block
  assert.match(out, /image_block="true"/);
  // backlinks on linked post (role=linked, has replyNos → backlinks shown)
  assert.match(out, /109931461/);
  // Footer for post link
  assert.match(out, /linked post.*posts it answers.*first 3 replies/);
});

// ---------------------------------------------------------------------------
// F. Compact zone outputs
// ---------------------------------------------------------------------------

test("F: compact renders thread link with subject and excerpt", () => {
  const payload: YotsubaPreviewPayload = {
    v: 1, kind: "thread", board: "g", boardTitle: "Technology",
    asOf: AS_OF_MS, threadNo: 109930292,
    subject: "/lmg/ - Local Models General",
    postCount: 435, headlineNo: 109930292,
    posts: [
      { no: 109930292, index: 0, role: "op", time: AS_OF_MS - 86400000,
        text: "/lmg/ - a general dedicated to the discussion and development of local language models.",
        quotes: [], replies: 3 },
    ],
  };

  const out = renderCompactMessage(chatEvent({ linkPreviews: [yotsubaPreview("https://boards.4chan.org/g/thread/109930292", payload)] }));

  assert.match(out, /\[4chan \/g\/ "\/lmg\/ - Local Models General" \(435 posts\):/);
  assert.match(out, /a general dedicated to the discussion/);
});

test("F: compact renders post link with subject, post reference, and excerpt", () => {
  const payload: YotsubaPreviewPayload = {
    v: 1, kind: "thread", board: "g",
    asOf: AS_OF_MS, threadNo: 109933629,
    opExcerpt: "why does every linux distro installer still ask…",
    postCount: 54, linkedNo: 109934102, headlineNo: 109934102,
    posts: [
      { no: 109934102, index: 20, role: "linked", time: AS_OF_MS - 1800000,
        text: "because the people who write installers are not the people who use installers",
        quotes: [], replies: 5 },
    ],
  };

  const out = renderCompactMessage(chatEvent({
    linkPreviews: [yotsubaPreview("https://boards.4chan.org/g/thread/109933629#p109934102", payload)],
  }));

  assert.match(out, /\[4chan \/g\/ "why does every linux distro installer still ask/);
  assert.match(out, /post >>109934102/);
  assert.match(out, /because the people who write installers/);
});

test("F: compact renders board link with thread count", () => {
  const payload: YotsubaPreviewPayload = {
    v: 1, kind: "board", board: "g", boardTitle: "Technology",
    asOf: AS_OF_MS,
    threads: [
      { no: 1, replies: 10, files: 2, time: AS_OF_MS - 3600000, subject: "Thread A" },
      { no: 2, replies: 5, files: 1, time: AS_OF_MS - 7200000, subject: "Thread B" },
      { no: 3, replies: 2, files: 0, time: AS_OF_MS - 10800000 },
    ],
  };

  const out = renderCompactMessage(chatEvent({ linkPreviews: [yotsubaPreview("https://boards.4chan.org/g/", payload)] }));
  assert.match(out, /\[4chan \/g\/ board: 3 threads\]/);
});

test("F: compact renders gone thread", () => {
  const out = renderCompactMessage(chatEvent({
    linkPreviews: [{
      url: "https://boards.4chan.org/g/thread/109800000",
      sourceKind: YOTSUBA_SOURCE_KIND,
      // No yotsubaPayload = gone
    }],
  }));
  assert.match(out, /\[4chan .* thread.*gone when linked\]/);
});

// ---------------------------------------------------------------------------
// G. Gone (404 at enrichment)
// ---------------------------------------------------------------------------

test("G: gone thread renders status='gone' with checked timestamp", () => {
  const fetchedAt = AS_OF_MS;
  const out = renderRichMessage(chatEvent({
    linkPreviews: [{
      url: "https://boards.4chan.org/g/thread/109800000",
      sourceKind: YOTSUBA_SOURCE_KIND,
      fetchedAt,
    }],
  }));

  assert.match(out, /<link_preview url="https:\/\/boards\.4chan\.org\/g\/thread\/109800000" kind="4chan" status="gone" checked="/);
});

// ---------------------------------------------------------------------------
// H. Board link rendering
// ---------------------------------------------------------------------------

test("H: board link renders board element with threads", () => {
  const payload: YotsubaPreviewPayload = {
    v: 1, kind: "board", board: "g", boardTitle: "Technology",
    worksafe: true, asOf: AS_OF_MS,
    threads: [
      { no: 109934266, replies: 97, files: 13, time: postMs("2026-09-28T22:40:00"), subject: "/lmg/ - Local Models General" },
      { no: 109934884, replies: 0, files: 0, time: postMs("2026-09-29T02:08:00"), opExcerpt: "is it worth upgrading from a 3080 to…" },
      { no: 109933660, replies: 3, files: 2, time: postMs("2026-09-28T20:15:00"), subject: "Autumn Dive/g/rass" },
    ],
  };

  const out = renderRichMessage(chatEvent({ linkPreviews: [yotsubaPreview("https://boards.4chan.org/g/", payload)] }));

  assert.match(out, /<link_preview url="https:\/\/boards\.4chan\.org\/g\/" kind="4chan">/);
  // code attribute includes board title: "/g/ - Technology"
  assert.match(out, /code="\/g\/ - Technology"/);
  assert.match(out, /title="Technology"/);
  assert.match(out, /worksafe="true"/);
  assert.match(out, /no="109934266"/);
  assert.match(out, /replies="97"/);
  assert.match(out, /files="13"/);
  assert.match(out, /\/lmg\/ - Local Models General/);
  assert.match(out, /no="109934884"/);
  assert.match(out, /op_excerpt="true"/);
  assert.match(out, /is it worth upgrading from a 3080 to/);
  assert.match(out, /Autumn Dive\/g\/rass/);
  assert.match(out, /\[4chan board: the top 3 threads on page 1\. The yotsuba tool can search the catalog\.\]/);
  assert.match(out, /<\/board>/);
});

// ---------------------------------------------------------------------------
// discord_embed suppression
// ---------------------------------------------------------------------------

test("discord_embed row is suppressed when same-URL yotsuba row is present", () => {
  const yotsubaLp: LinkPreviewMeta = {
    url: "https://boards.4chan.org/g/thread/109930292",
    sourceKind: YOTSUBA_SOURCE_KIND,
    fetchedAt: AS_OF_MS,
    // No payload = gone rendering
  };
  const discordLp: LinkPreviewMeta = {
    url: "https://boards.4chan.org/g/thread/109930292",
    sourceKind: "discord_embed",
    title: "4chan Thread",
    description: "bare og card text",
  };

  const out = renderRichMessage(chatEvent({ linkPreviews: [yotsubaLp, discordLp] }));
  // discord_embed rendered text should be absent
  assert.ok(!out.includes("bare og card text"), "discord_embed description should be suppressed");
  // yotsuba row should be present
  assert.match(out, /status="gone"/);
});

test("discord_embed suppression uses normalized URL (strips hash)", () => {
  const yotsubaLp: LinkPreviewMeta = {
    url: "https://boards.4chan.org/g/thread/109930292",
    sourceKind: YOTSUBA_SOURCE_KIND,
    fetchedAt: AS_OF_MS,
  };
  const discordLp: LinkPreviewMeta = {
    url: "https://boards.4chan.org/g/thread/109930292#p109931000",
    sourceKind: "discord_embed",
    description: "discord embed card",
  };

  const out = renderRichMessage(chatEvent({ linkPreviews: [yotsubaLp, discordLp] }));
  assert.ok(!out.includes("discord embed card"), "hash-variant discord_embed should be suppressed");
});

test("non-yotsuba discord_embed is not suppressed", () => {
  const discordLp: LinkPreviewMeta = {
    url: "https://boards.4chan.org/g/thread/109930292",
    sourceKind: "discord_embed",
    description: "discord embed card only",
  };

  const out = renderRichMessage(chatEvent({ linkPreviews: [discordLp] }));
  assert.match(out, /discord embed card only/);
});

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------

test("board title with special chars is XML-escaped in attributes", () => {
  const payload: YotsubaPreviewPayload = {
    v: 1, kind: "board", board: "s4s",
    boardTitle: "Shit 4chan Says <test> & \"fun\"",
    asOf: AS_OF_MS,
    threads: [],
  };

  const out = renderRichMessage(chatEvent({ linkPreviews: [yotsubaPreview("https://boards.4chan.org/s4s/", payload)] }));
  // Attribute should be escaped
  assert.match(out, /title="Shit 4chan Says &lt;test&gt; &amp; &quot;fun&quot;"/);
});

test("post text with XML special chars is escaped in content", () => {
  // escapeXml escapes <, >, & (angle brackets and ampersand)
  // but does NOT escape " in text content (valid XML content)
  const payload: YotsubaPreviewPayload = {
    v: 1, kind: "thread", board: "g",
    asOf: AS_OF_MS, threadNo: 100001, headlineNo: 100001, postCount: 1,
    posts: [
      { no: 100001, index: 0, role: "op", time: AS_OF_MS - 3600000,
        text: "use <stdio.h> & 'printf' for \"hello world\"",
        quotes: [], replies: 0 },
    ],
  };

  const out = renderRichMessage(chatEvent({ linkPreviews: [yotsubaPreview("https://boards.4chan.org/g/thread/100001", payload)] }));
  // Angle brackets and ampersand are escaped; double quotes in text content are not
  assert.match(out, /&lt;stdio\.h&gt; &amp; 'printf' for "hello world"/);
});

// ---------------------------------------------------------------------------
// Omitted gap markers
// ---------------------------------------------------------------------------

test("gap markers appear between non-contiguous posts", () => {
  const upgrade = {
    triggerGroupId: "tg_gap",
    includedNos: [1, 10],
    processedAssetIds: [],
  };

  const posts: YotsubaPostNode[] = [
    { no: 1, index: 0, role: "op", time: AS_OF_MS - 86400000, text: "OP text", quotes: [], replies: 0 },
    { no: 5, index: 4, role: "latest", time: AS_OF_MS - 3600000, text: "not included", quotes: [], replies: 0 },
    { no: 10, index: 9, role: "latest", time: AS_OF_MS - 1800000, text: "included reply", quotes: [], replies: 0 },
  ];

  const payload: YotsubaPreviewPayload = {
    v: 1, kind: "thread", board: "g",
    asOf: AS_OF_MS, threadNo: 1, headlineNo: 1, postCount: 10,
    posts,
    upgrade,
  };

  const out = renderRichMessage(chatEvent({ linkPreviews: [yotsubaPreview("https://boards.4chan.org/g/thread/1", payload)] }));
  assert.match(out, /<omitted posts=/);
});

// ---------------------------------------------------------------------------
// Quote annotation edge cases
// ---------------------------------------------------------------------------

test(">>N to shown post has no annotation", () => {
  const upgrade = { triggerGroupId: "tg_q", includedNos: [1, 2], processedAssetIds: [] };
  const posts: YotsubaPostNode[] = [
    { no: 1, index: 0, role: "op", time: AS_OF_MS - 86400000, text: "first", quotes: [], replies: 1 },
    { no: 2, index: 1, role: "latest", time: AS_OF_MS - 3600000, text: ">>1 reply to OP", quotes: [1], replies: 0 },
  ];
  const payload: YotsubaPreviewPayload = {
    v: 1, kind: "thread", board: "g",
    asOf: AS_OF_MS, threadNo: 1, headlineNo: 1, postCount: 2,
    posts, upgrade,
  };

  const out = renderRichMessage(chatEvent({ linkPreviews: [yotsubaPreview("https://boards.4chan.org/g/thread/1", payload)] }));
  // >>1 should appear without annotation since post 1 is shown
  assert.match(out, /&gt;&gt;1(<\/post>| reply)/);
  assert.ok(!out.includes(">>1 (not shown)"), "OP reference should not be annotated as not shown");
  assert.ok(!out.includes(">>1 (OP)"), "OP reference should not get (OP) since OP is shown");
});

test(">>N to OP when OP not in shownNos gets (OP) annotation", () => {
  // Post link: OP is not in includedNos (only linked post + replies)
  const upgrade = { triggerGroupId: "tg_op", includedNos: [500], processedAssetIds: [] };
  const posts: YotsubaPostNode[] = [
    { no: 1, index: 0, role: "op", time: AS_OF_MS - 86400000, text: "OP content", quotes: [], replies: 1 },
    { no: 500, index: 499, role: "linked", time: AS_OF_MS - 3600000, text: ">>1 thanks OP", quotes: [1], replies: 0 },
  ];
  const payload: YotsubaPreviewPayload = {
    v: 1, kind: "thread", board: "g",
    asOf: AS_OF_MS, threadNo: 1, headlineNo: 500, linkedNo: 500, postCount: 500,
    posts, upgrade,
  };

  const out = renderRichMessage(chatEvent({ linkPreviews: [yotsubaPreview("https://boards.4chan.org/g/thread/1#p500", payload)] }));
  assert.match(out, /&gt;&gt;1 \(OP\)/);
});
