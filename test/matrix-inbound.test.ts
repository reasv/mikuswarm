import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { processMatrixInboundEvent } from "../src/matrix/inbound.js";
import type { MatrixNativeClient } from "../src/matrix/native-client.js";
import type { MatrixInboundEvent } from "../src/matrix/native-types.js";

test("Matrix direct events keep dm timeline identity and exact outbound room target", async () => {
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

  const inbound = await processMatrixInboundEvent(nativeEvent, {
    accountId: "miku",
    selfUserId: "@miku:example.org",
    mentionNames: ["miku"],
    client: inertClient(),
  });

  assert.equal(inbound.timelineKey, "matrix:miku:dm:@alice:example.org");
  assert.equal(inbound.outboundTarget?.roomId, "!room:example.org");
  assert.equal(inbound.outboundTarget?.accountId, "miku");
  assert.equal(inbound.trigger?.type, "dm");
});

test("Matrix reply context downloads media attachments for replied-to media events", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-matrix-"));
  try {
    const client = {
      messageSummary: () => ({
        eventId: "$image",
        sender: "@alice:example.org",
        body: "picture.jpg",
        msgtype: "m.image",
        timestamp: new Date(500).toISOString(),
      }),
      downloadMedia: () => ({
        roomId: "!room:example.org",
        eventId: "$image",
        kind: "image",
        filename: "picture.jpg",
        contentType: "image/jpeg",
        dataBase64: Buffer.from("fake-image").toString("base64"),
      }),
      resolveLinkPreviews: () => ({ textBlocks: [], media: [], sources: [] }),
    } as unknown as MatrixNativeClient;

    const nativeEvent: MatrixInboundEvent = {
      roomId: "!room:example.org",
      eventId: "$reply",
      senderId: "@alice:example.org",
      chatType: "channel",
      body: "@miku what is this?",
      mentions: { userIds: ["@miku:example.org"] },
      replyToId: "$image",
      timestamp: new Date(1_000).toISOString(),
      media: [],
    };

    const inbound = await processMatrixInboundEvent(nativeEvent, {
      accountId: "miku",
      selfUserId: "@miku:example.org",
      mentionNames: ["miku"],
      attachmentDir: dir,
      client,
    });

    assert.equal(inbound.event.replyTo?.externalId, "$image");
    assert.equal(inbound.event.replyTo?.attachments?.length, 1);
    assert.equal(inbound.event.replyTo?.attachments?.[0]?.mediaType, "image");
    assert.match(inbound.event.replyTo?.attachments?.[0]?.localPath ?? "", /_image-_image_media_0\.jpg$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function inertClient(): MatrixNativeClient {
  return {
    messageSummary: () => null,
    resolveLinkPreviews: () => ({ textBlocks: [], media: [], sources: [] }),
  } as unknown as MatrixNativeClient;
}
