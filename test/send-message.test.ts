import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createSendMessageTool, type SendMessageToolContext } from "../src/tools/send-message.js";
import type {
  IChatProvider,
  DeliveryReceipt,
  OutboundMessage,
  OutboundTarget,
} from "../src/types.js";
import type { TimelineStore } from "../src/timeline/index.js";

interface SendCall {
  target: OutboundTarget;
  message: OutboundMessage;
}

function makeProvider(): { provider: IChatProvider; calls: SendCall[] } {
  const calls: SendCall[] = [];
  let counter = 0;
  const provider = {
    id: "matrix",
    capabilities: {},
    async start() {},
    async stop() {},
    accountIds() { return []; },
    getSelf() { return undefined; },
    ownsUserId() { return false; },
    enrichment() { return undefined; },
    async send(target: OutboundTarget, message: OutboundMessage): Promise<DeliveryReceipt> {
      calls.push({ target, message });
      return {
        provider: "matrix",
        target,
        externalId: `$evt${counter++}`,
        deliveredAt: Date.now(),
      };
    },
    async setTyping() {},
  } as unknown as IChatProvider;
  return { provider, calls };
}

function makeTimeline(): TimelineStore {
  return {
    append: async () => {},
    ingestAssistantSend: async () => "appended" as const,
  } as unknown as TimelineStore;
}

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-sendmsg-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("media-only send (empty message) still delivers the attachment", async () => {
  await withWorkspace(async (workspace) => {
    const cardPath = path.join(workspace, "card.png");
    // Minimal PNG header bytes — content doesn't matter, only that the file exists.
    await writeFile(cardPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const { provider, calls } = makeProvider();
    const context: SendMessageToolContext = {
      provider,
      target: { provider: "matrix", timelineKey: "matrix:bot:room:!r:hs" },
      timeline: makeTimeline(),
      agentSessionId: "sess-1",
      workspaceRoot: workspace,
    };
    const tool = createSendMessageTool(context);

    const result = await tool.execute("call-1", {
      message: "",
      media: "card.png",
      is_reply: false,
      final: true,
    });

    // Regression: an empty body used to chunk to zero entries, so the send loop
    // never ran and the attachment was silently dropped ("sent 0 chunks:").
    assert.equal(calls.length, 1, "exactly one Matrix send should occur");
    assert.equal(calls[0].message.attachments?.length, 1, "the attachment must ride the send");
    assert.equal(calls[0].message.attachments?.[0].filename, "card.png");
    assert.equal(calls[0].message.body, "");

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.match(text, /^sent: /, `expected a real receipt, got: ${text}`);
  });
});

test("empty send with no media is rejected and points at NO_REPLY", async () => {
  await withWorkspace(async (workspace) => {
    const { provider, calls } = makeProvider();
    const context: SendMessageToolContext = {
      provider,
      target: { provider: "matrix", timelineKey: "matrix:bot:room:!r:hs" },
      timeline: makeTimeline(),
      agentSessionId: "sess-noop",
      workspaceRoot: workspace,
    };
    const tool = createSendMessageTool(context);

    const result = await tool.execute("call-noop", {
      message: "   ",
      is_reply: false,
      // final: true means the agent intended to END the turn with this call. A
      // no-op must NOT honor that — otherwise the turn ends having delivered nothing.
      final: true,
    });

    assert.equal(calls.length, 0, "a no-op send must not reach the provider");
    assert.notEqual(
      (result as { terminate?: boolean }).terminate,
      true,
      "a rejected no-op must not terminate the turn, even with final: true",
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.match(text, /^error:/);
    assert.match(text, /NO_REPLY/);
  });
});

test("text + media send delivers the attachment on the first chunk", async () => {
  await withWorkspace(async (workspace) => {
    const cardPath = path.join(workspace, "pic.png");
    await writeFile(cardPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const { provider, calls } = makeProvider();
    const context: SendMessageToolContext = {
      provider,
      target: { provider: "matrix", timelineKey: "matrix:bot:room:!r:hs" },
      timeline: makeTimeline(),
      agentSessionId: "sess-2",
      workspaceRoot: workspace,
    };
    const tool = createSendMessageTool(context);

    await tool.execute("call-2", {
      message: "here it is",
      media: "pic.png",
      is_reply: false,
      final: true,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].message.body, "here it is");
    assert.equal(calls[0].message.attachments?.length, 1);
  });
});
