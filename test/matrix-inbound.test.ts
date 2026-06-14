import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeMatrixInboundEvent } from "../src/matrix/inbound.js";
import { MatrixProvider } from "../src/matrix/provider.js";
import type { MatrixInboundEvent } from "../src/matrix/native-types.js";
import type { InboundChatEvent } from "../src/types.js";

test("Matrix direct events keep dm timeline identity and exact outbound room target", () => {
  const nativeEvent: MatrixInboundEvent = {
    roomId: "!room:example.org",
    eventId: "$event",
    senderId: "@alice:example.org",
    senderName: "Alice",
    chatType: "direct",
    body: "hello",
    timestamp: new Date(1_000).toISOString(),
    media: [],
  };

  const inbound = normalizeMatrixInboundEvent(nativeEvent, {
    accountId: "miku",
    selfUserId: "@miku:example.org",
  });

  assert.equal(inbound.timelineKey, "matrix:miku:dm:!room:example.org");
  assert.equal(inbound.outboundTarget?.roomId, "!room:example.org");
  assert.equal(inbound.outboundTarget?.accountId, "miku");
  assert.equal(inbound.trigger?.type, "dm");
});

test("UTD inbound events propagate undecryptable and never attach a trigger", () => {
  // A UTD event in a DM would normally trigger (dm type), and one mentioning the
  // bot would trigger (mention). Neither must fire — a human client wouldn't act
  // on a message it can't read.
  const utdDm: MatrixInboundEvent = {
    roomId: "!room:example.org",
    eventId: "$utd",
    senderId: "@alice:example.org",
    chatType: "direct",
    body: "",
    timestamp: new Date(1_000).toISOString(),
    media: [],
    undecryptable: true,
    sessionId: "session-xyz",
    utdReason: "missing_megolm_session",
  };

  const inbound = normalizeMatrixInboundEvent(utdDm, {
    accountId: "miku",
    selfUserId: "@miku:example.org",
  });

  assert.deepEqual(inbound.event.undecryptable, {
    sessionId: "session-xyz",
    reason: "missing_megolm_session",
  });
  assert.equal(inbound.event.body, "", "no plaintext on a UTD event");
  assert.equal(inbound.trigger, undefined, "UTD must not trigger (even in a DM)");
  assert.equal(inbound.event.trigger, undefined);
});

test("Matrix provider preserves body text separately when sending attachments", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-send-"));
  try {
    const filePath = path.join(dir, "image.jpg");
    await writeFile(filePath, "fake-image");
    const sends: unknown[] = [];
    const uploads: unknown[] = [];
    const provider = new MatrixProvider();
    (provider as any).accounts.set("miku", {
      accountId: "miku",
      selfUserId: "@miku:example.org",
      client: {
        sendMessage: (request: unknown) => {
          sends.push(request);
          return { roomId: "!room:example.org", messageId: "$text" };
        },
        uploadMedia: (request: unknown) => {
          uploads.push(request);
          return { roomId: "!room:example.org", messageId: "$media" };
        },
      },
    });

    const receipt = await provider.send(
      {
        provider: "matrix",
        timelineKey: "matrix:miku:room:!room:example.org",
        accountId: "miku",
        roomId: "!room:example.org",
        replyToId: "$reply",
      },
      {
        body: "body text",
        attachments: [
          {
            id: "a1",
            mediaType: "image",
            mimeType: "image/jpeg",
            filename: "image.jpg",
            localPath: filePath,
          },
        ],
      },
    );

    assert.equal(receipt.externalId, "$text");
    assert.deepEqual(receipt.externalIds, ["$text", "$media"]);
    assert.deepEqual(sends, [
      {
        roomId: "!room:example.org",
        text: "body text",
        html: undefined,
        threadId: undefined,
        replyToId: "$reply",
      },
    ]);
    assert.equal((uploads[0] as any).caption, undefined);
    assert.equal((uploads[0] as any).replyToId, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Matrix provider forwards formatted HTML bodies to native text sends", async () => {
  const sends: unknown[] = [];
  const provider = new MatrixProvider();
  (provider as any).accounts.set("miku", {
    accountId: "miku",
    selfUserId: "@miku:example.org",
    client: {
      sendMessage: (request: unknown) => {
        sends.push(request);
        return { roomId: "!room:example.org", messageId: "$sent" };
      },
    },
  });

  const receipt = await provider.send(
    {
      provider: "matrix",
      timelineKey: "matrix:miku:room:!room:example.org",
      accountId: "miku",
      roomId: "!room:example.org",
    },
    {
      body: "hello",
      htmlBody: "<strong>hello</strong>",
    },
  );

  assert.equal(receipt.externalId, "$sent");
  assert.deepEqual(sends, [
    {
      roomId: "!room:example.org",
      text: "hello",
      html: "<strong>hello</strong>",
      threadId: undefined,
    },
  ]);
});

test("Matrix direct self echoes keep the room target even when timeline identity is self", () => {
  const nativeEvent: MatrixInboundEvent = {
    roomId: "!dm:example.org",
    eventId: "$self",
    senderId: "@miku:example.org",
    senderName: "Miku",
    chatType: "direct",
    body: "hello",
    timestamp: new Date(1_000).toISOString(),
    media: [],
  };

  const inbound = normalizeMatrixInboundEvent(nativeEvent, {
    accountId: "miku",
    selfUserId: "@miku:example.org",
  });

  assert.equal(inbound.timelineKey, "matrix:miku:dm:!dm:example.org");
  assert.equal(inbound.outboundTarget?.roomId, "!dm:example.org");
  assert.equal(inbound.trigger, undefined);
});

test("Matrix live media maps to attachments with the canonical shape", () => {
  const nativeEvent: MatrixInboundEvent = {
    roomId: "!room:example.org",
    eventId: "$img",
    senderId: "@alice:example.org",
    senderName: "Alice",
    chatType: "channel",
    body: "cat.png",
    msgtype: "m.image",
    timestamp: new Date(1_000).toISOString(),
    media: [
      { index: 0, kind: "image", body: "cat.png", filename: "cat.png", contentType: "image/png", sizeBytes: 1234 },
    ],
  };

  const inbound = normalizeMatrixInboundEvent(nativeEvent, {
    accountId: "miku",
    selfUserId: "@miku:example.org",
  });

  assert.deepEqual(inbound.event.attachments, [
    {
      id: "$img:media:0",
      filename: "cat.png",
      mimeType: "image/png",
      mediaType: "image",
      sizeBytes: 1234,
      processing: { downloaded: false, captioned: false },
    },
  ]);
});

test("Matrix room triggers require structured Matrix mention metadata", () => {
  const textOnlyMention: MatrixInboundEvent = {
    roomId: "!room:example.org",
    eventId: "$text-only",
    senderId: "@alice:example.org",
    senderName: "Alice",
    chatType: "channel",
    body: "@miku this is just text",
    timestamp: new Date(1_000).toISOString(),
    media: [],
  };
  const structuredMention: MatrixInboundEvent = {
    ...textOnlyMention,
    eventId: "$structured",
    mentions: { userIds: ["@miku:example.org"] },
  };

  const textOnly = normalizeMatrixInboundEvent(textOnlyMention, {
    accountId: "miku",
    selfUserId: "@miku:example.org",
  });
  const structured = normalizeMatrixInboundEvent(structuredMention, {
    accountId: "miku",
    selfUserId: "@miku:example.org",
  });

  assert.equal(textOnly.event.mentions?.mentionedSelf, false);
  assert.equal(textOnly.trigger, undefined);
  assert.equal(structured.event.mentions?.mentionedSelf, true);
  assert.equal(structured.trigger?.type, "mention");
});

test("Matrix provider delivers a trigger event TWICE — same event.id, trigger stripped then populated", async () => {
  // Premise underlying the interjection dedup in app.ts (steerReplyToActiveSession):
  // the trigger hold emits every trigger-bearing event immediately with
  // `trigger: undefined` (for ingestion) and AGAIN after `trigger_hold_ms` with
  // the trigger populated (for the spawn decision). Both deliveries carry the same
  // `event.id`. `handleInbound` runs on both, so anything non-idempotent on that
  // path (steering a reply into a live session) must dedup by event id, or the
  // interjection lands twice. See ARCHITECTURE.md §"Trigger hold".
  const provider = new MatrixProvider();
  // emitWithTriggerHold only reads `config` truthiness + `trigger_hold_ms`.
  (provider as unknown as { config: { trigger_hold_ms: number } }).config = { trigger_hold_ms: 5 };

  const deliveries: InboundChatEvent[] = [];
  provider.subscribe((event) => deliveries.push(event));

  // A DM reply is always a trigger (type "dm") — the common interjection path.
  const dmReply: MatrixInboundEvent = {
    roomId: "!room:example.org",
    eventId: "$reply",
    senderId: "@alice:example.org",
    senderName: "Alice",
    chatType: "direct",
    body: "actually, wait —",
    timestamp: new Date(1_000).toISOString(),
    media: [],
    replyToId: "$bot-msg",
  };
  const inbound = normalizeMatrixInboundEvent(dmReply, {
    accountId: "miku",
    selfUserId: "@miku:example.org",
  });
  assert.equal(inbound.trigger?.type, "dm", "DM reply is a trigger");

  (provider as unknown as { emitWithTriggerHold(e: InboundChatEvent): void }).emitWithTriggerHold(inbound);

  // Immediate emit: trigger stripped, for ingestion.
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].trigger, undefined);
  const eventId = deliveries[0].event.id;

  // Post-hold re-emit: SAME event id, trigger now populated.
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(deliveries.length, 2, "trigger event is delivered twice");
  assert.ok(deliveries[1].trigger, "second delivery carries the trigger");
  assert.equal(deliveries[1].event.id, eventId, "both deliveries share one event.id");
});
