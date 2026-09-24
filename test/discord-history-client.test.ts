import assert from "node:assert/strict";
import test from "node:test";
import { DiscordAPIError, type Client } from "discord.js";
import { DiscordHistoryClient } from "../src/discord/history-client.js";
import { HistoryUnavailableError } from "../src/backfill/paginate.js";

/**
 * DiscordHistoryClient contract for the shared backfill classifiers
 * (`classifyForRoom` / `classifyForTimeline`, ARCHITECTURE.md §7b/§7c):
 *  - a thread channel's summaries carry `threadRootExternalId` = the thread id
 *    (so they route to the `…:thread:<id>` timeline key instead of the parent);
 *  - an edited message is a plain summary with its current content, never an
 *    `edited` replacement event (which the classifiers apply as an edit or drop
 *    when it names no target);
 *  - 403/404 from the messages endpoint surface as HistoryUnavailableError so
 *    gap backfetch can release the channel instead of freezing it.
 */

function raw(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    content: "hello",
    author: { id: "u1", username: "alice", global_name: "Alice" },
    timestamp: new Date(1_700_000_000_000).toISOString(),
    edited_timestamp: null,
    attachments: [],
    ...over,
  };
}

function fakeClient(handler: (route: string) => unknown): Client {
  return { rest: { get: async (route: string) => handler(route) } } as unknown as Client;
}

test("thread channel: every summary carries threadRootExternalId = the thread id; a room channel leaves it unset", async () => {
  const routes: string[] = [];
  const client = fakeClient((route) => {
    routes.push(route);
    return [raw("2"), raw("1")];
  });

  const thread = new DiscordHistoryClient(client, "777", "bot", "777");
  const inThread = await thread.readMessages({ limit: 50 });
  assert.deepEqual(inThread.messages.map((m) => m.threadRootExternalId), ["777", "777"]);
  assert.equal(routes[0], "/channels/777/messages", "a thread client pages the thread's own channel");

  const room = new DiscordHistoryClient(client, "111", "bot");
  const inRoom = await room.readMessages({ limit: 50 });
  assert.deepEqual(inRoom.messages.map((m) => m.threadRootExternalId), [undefined, undefined]);
  assert.equal(routes[1], "/channels/111/messages");
});

test("an edited message is a normal summary with its current content — never an `edited` replacement event", async () => {
  const client = fakeClient(() => [raw("5", { content: "current text", edited_timestamp: new Date().toISOString() })]);
  const history = new DiscordHistoryClient(client, "111", "bot");
  const { messages } = await history.readMessages({});
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.body, "current text");
  assert.equal(messages[0]!.edited, undefined);
  assert.equal(messages[0]!.editTargetExternalId, undefined);
});

test("HTTP 403/404 from the messages endpoint surface as HistoryUnavailableError; other failures pass through unchanged", async () => {
  const apiError = (status: number, code: number, message: string) =>
    new DiscordAPIError({ message, code }, code, status, "GET", "https://discord.com/api/v10/channels/111/messages", {
      files: undefined,
      json: undefined,
    });

  const forbidden = new DiscordHistoryClient(fakeClient(() => { throw apiError(403, 50001, "Missing Access"); }), "111", "bot");
  await assert.rejects(forbidden.readMessages({}), (err: unknown) => {
    assert.ok(err instanceof HistoryUnavailableError);
    assert.match(err.message, /channel 111/);
    assert.match(err.message, /HTTP 403/);
    return true;
  });

  const gone = new DiscordHistoryClient(fakeClient(() => { throw apiError(404, 10003, "Unknown Channel"); }), "111", "bot");
  await assert.rejects(gone.readMessages({}), HistoryUnavailableError);

  const serverError = apiError(500, 0, "Internal Server Error");
  const flaky = new DiscordHistoryClient(fakeClient(() => { throw serverError; }), "111", "bot");
  await assert.rejects(flaky.readMessages({}), (err: unknown) => err === serverError);

  const plain = new Error("socket hang up");
  const network = new DiscordHistoryClient(fakeClient(() => { throw plain; }), "111", "bot");
  await assert.rejects(network.readMessages({}), (err: unknown) => err === plain);
});
