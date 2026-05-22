import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { processMatrixInboundEvent } from "../src/matrix/inbound.js";
import { MatrixProvider } from "../src/matrix/provider.js";
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

test("Matrix direct self echoes keep the room target even when timeline identity is self", async () => {
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

  const inbound = await processMatrixInboundEvent(nativeEvent, {
    accountId: "miku",
    selfUserId: "@miku:example.org",
    client: inertClient(),
  });

  assert.equal(inbound.timelineKey, "matrix:miku:dm:@miku:example.org");
  assert.equal(inbound.outboundTarget?.roomId, "!dm:example.org");
  assert.equal(inbound.trigger, undefined);
});

test("Matrix room triggers require structured Matrix mention metadata", async () => {
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

  const textOnly = await processMatrixInboundEvent(textOnlyMention, {
    accountId: "miku",
    selfUserId: "@miku:example.org",
    client: inertClient(),
  });
  const structured = await processMatrixInboundEvent(structuredMention, {
    accountId: "miku",
    selfUserId: "@miku:example.org",
    client: inertClient(),
  });

  assert.equal(textOnly.event.mentions?.mentionedSelf, false);
  assert.equal(textOnly.trigger, undefined);
  assert.equal(structured.event.mentions?.mentionedSelf, true);
  assert.equal(structured.trigger?.type, "mention");
});

function inertClient(): MatrixNativeClient {
  return {
    messageSummary: () => null,
    resolveLinkPreviews: () => ({ textBlocks: [], media: [], sources: [] }),
  } as unknown as MatrixNativeClient;
}
