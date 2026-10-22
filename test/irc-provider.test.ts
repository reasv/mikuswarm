/**
 * Tests for src/irc/provider.ts — construction, capabilities, and shape tests
 * that do not require a live socket.
 *
 * No irc-framework Client is actually constructed in these tests (no network I/O).
 * The provider is tested by inspecting its static properties and calling pure
 * methods (ownsUserId, accountIds, getSelf before start, channelClient for
 * foreign targets, enrichment).
 *
 * Coverage:
 *   - IrcProvider.capabilities exactly per spec §6
 *   - ownsUserId: shape test — permissive but excluding @-prefixed, all-digit, whitespace
 *   - accountIds: empty before start
 *   - getSelf: undefined before start
 *   - channelClient: undefined for foreign targets
 *   - enrichment: undefined (IRC has no enrichment)
 *   - Construction with empty accounts config does not throw
 *   - Behavior tests with mocked client (F1–F7):
 *     F1: 'socket close' → registered=false, send() rejects
 *     F2: CAP DEL required cap → capDelReconnect, reconnect on close
 *     F3: 'user updated' for self → learnHostmask; for other nick → no-op
 *     F5: trigger_hold_ms=0 → immediate; >0 → coalesce
 *     F7: floor-cap failure → capFailed + onError; echo-merge → real msgid; echo timeout → synthetic id
 *     N1–N9: nick fallback (alt_nicks → generated → bounded exhaustion), reclaim, reconnect reset
 */

import assert from "node:assert/strict";
import test, { describe, mock } from "node:test";
import { EventEmitter } from "node:events";
import { IrcProvider, buildNickCandidates } from "../src/irc/provider.js";
import { AccountTracker } from "../src/irc/account-tracker.js";
import { RosterTracker } from "../src/irc/roster-tracker.js";
import type { IrcConfig } from "../src/config/schema.js";

function makeProvider(accounts: IrcConfig["accounts"] = {}): IrcProvider {
  return new IrcProvider({
    enabled: true,
    accounts,
  });
}

// ── capabilities ─────────────────────────────────────────────────────────────

test("IrcProvider.capabilities: typing is true", () => {
  const p = makeProvider();
  assert.equal(p.capabilities.typing, true);
});

test("IrcProvider.capabilities: reactions is false", () => {
  const p = makeProvider();
  assert.equal(p.capabilities.reactions, false);
});

test("IrcProvider.capabilities: mediaUpload is false", () => {
  const p = makeProvider();
  assert.equal(p.capabilities.mediaUpload, false);
});

test("IrcProvider.capabilities: maxAttachmentsPerMessage is 0", () => {
  const p = makeProvider();
  assert.equal(p.capabilities.maxAttachmentsPerMessage, 0);
});

test("IrcProvider.capabilities: maxMessageChars is 400", () => {
  const p = makeProvider();
  assert.equal(p.capabilities.maxMessageChars, 400);
});

test("IrcProvider.capabilities: formatting is 'plain'", () => {
  const p = makeProvider();
  assert.equal(p.capabilities.formatting, "plain");
});

test("IrcProvider.capabilities: edits is false", () => {
  const p = makeProvider();
  assert.equal(p.capabilities.edits, false);
});

test("IrcProvider.capabilities: deletes is false", () => {
  const p = makeProvider();
  assert.equal(p.capabilities.deletes, false);
});

test("IrcProvider.capabilities: pollCreate is false", () => {
  const p = makeProvider();
  assert.equal(p.capabilities.pollCreate, false);
});

test("IrcProvider.capabilities: pollVote is false", () => {
  const p = makeProvider();
  assert.equal(p.capabilities.pollVote, false);
});

test("IrcProvider.capabilities: pins is false", () => {
  const p = makeProvider();
  assert.equal(p.capabilities.pins, false);
});

test("IrcProvider.capabilities: voiceMessages is false", () => {
  const p = makeProvider();
  assert.equal(p.capabilities.voiceMessages, false);
});

test("IrcProvider.capabilities: threads is false", () => {
  const p = makeProvider();
  assert.equal(p.capabilities.threads, false);
});

test("IrcProvider.capabilities: history is false", () => {
  const p = makeProvider();
  assert.equal(p.capabilities.history, false);
});

test("IrcProvider.capabilities: encrypted is false", () => {
  const p = makeProvider();
  assert.equal(p.capabilities.encrypted, false);
});

test("IrcProvider.capabilities: linkPreviews is 'none'", () => {
  const p = makeProvider();
  assert.equal(p.capabilities.linkPreviews, "none");
});

test("IrcProvider.capabilities: singleAttachmentPerMessage is false", () => {
  const p = makeProvider();
  assert.equal(p.capabilities.singleAttachmentPerMessage, false);
});

test("IrcProvider.capabilities: membershipRoster is true", () => {
  const p = makeProvider();
  assert.equal(p.capabilities.membershipRoster, true);
});

// ── id ───────────────────────────────────────────────────────────────────────

test("IrcProvider.id is 'irc'", () => {
  const p = makeProvider();
  assert.equal(p.id, "irc");
});

// ── accountIds before start ───────────────────────────────────────────────────

test("IrcProvider.accountIds: empty array before start", () => {
  const p = makeProvider();
  assert.deepEqual(p.accountIds(), []);
});

// ── getSelf before start ──────────────────────────────────────────────────────

test("IrcProvider.getSelf: undefined for any accountId before start", () => {
  const p = makeProvider();
  assert.equal(p.getSelf("myaccount"), undefined);
  assert.equal(p.getSelf("nonexistent"), undefined);
});

// ── ownsUserId ────────────────────────────────────────────────────────────────

test("ownsUserId: accepts network-scoped IRC id (<networkId>/<identity>)", () => {
  const p = makeProvider();
  assert.ok(p.ownsUserId("libera.chat/miku"));
  assert.ok(p.ownsUserId("irc.example.net/bot-user"));
  assert.ok(p.ownsUserId("efnet/Bot_123"));
  assert.ok(p.ownsUserId("undernet/[miku]"));
  assert.ok(p.ownsUserId("test.net/a"));
  assert.ok(p.ownsUserId("irc.net/alice_services")); // services account
});

test("ownsUserId: rejects bare IRC nick (not network-scoped)", () => {
  const p = makeProvider();
  // Bare nicks have no '/' separator — not a valid scoped IRC id.
  assert.ok(!p.ownsUserId("miku"));
  assert.ok(!p.ownsUserId("bot-user"));
  assert.ok(!p.ownsUserId("Bot_123"));
  assert.ok(!p.ownsUserId("[miku]"));
  assert.ok(!p.ownsUserId("a"));
});

test("ownsUserId: rejects empty string", () => {
  const p = makeProvider();
  assert.ok(!p.ownsUserId(""));
});

test("ownsUserId: rejects @-prefixed id (Matrix-style MXID)", () => {
  const p = makeProvider();
  assert.ok(!p.ownsUserId("@user:server.com"));
  assert.ok(!p.ownsUserId("@anything"));
});

test("ownsUserId: rejects all-digit id (Discord-style snowflake)", () => {
  const p = makeProvider();
  assert.ok(!p.ownsUserId("1234567890"));
  assert.ok(!p.ownsUserId("0"));
});

test("ownsUserId: rejects id with whitespace", () => {
  const p = makeProvider();
  assert.ok(!p.ownsUserId("nick name"));
  assert.ok(!p.ownsUserId("nick\tname"));
  assert.ok(!p.ownsUserId("nick\nname"));
});

test("ownsUserId: rejects id with NUL byte", () => {
  const p = makeProvider();
  assert.ok(!p.ownsUserId("nick\0name"));
});

// ── channelClient ─────────────────────────────────────────────────────────────

test("IrcProvider.channelClient: undefined for non-irc timeline key", () => {
  const p = makeProvider();
  assert.equal(
    p.channelClient({
      provider: "matrix",
      timelineKey: "matrix:acc:room:!room:server.com",
    }),
    undefined,
  );
});

test("IrcProvider.channelClient: undefined for unknown accountId", () => {
  const p = makeProvider();
  assert.equal(
    p.channelClient({
      provider: "irc",
      timelineKey: "irc:unknownaccount:room:#general",
    }),
    undefined,
  );
});

// ── enrichment ────────────────────────────────────────────────────────────────

test("IrcProvider.enrichment: always returns undefined", () => {
  const p = makeProvider();
  assert.equal(p.enrichment("any-account"), undefined);
});

// ── construction ──────────────────────────────────────────────────────────────

test("IrcProvider: constructs without throwing when accounts is empty", () => {
  assert.doesNotThrow(() => {
    makeProvider({});
  });
});

test("IrcProvider: constructs without throwing when accounts is undefined", () => {
  assert.doesNotThrow(() => {
    new IrcProvider({ enabled: true });
  });
});

test("IrcProvider: stop() is safe to call before start()", async () => {
  const p = makeProvider();
  await assert.doesNotReject(() => p.stop());
});

// ── Behavior tests (mocked irc-framework client) ──────────────────────────────
//
// These tests exercise the live-event path of IrcProvider without opening a real
// socket. A minimal MockClient (Node.js EventEmitter + stubbed methods) is
// injected directly into the AccountRuntime; attachListeners() wires up the
// event handlers, and emitting events on the mock triggers the same code paths
// as a live connection.

class MockClient extends EventEmitter {
  network: {
    cap: { enabled: string[] };
    supports(name: string): string | boolean | undefined;
  } = {
    cap: { enabled: [] },
    supports(_name: string) { return undefined; },
  };

  user = { nick: "testbot", username: "testbot", host: "", away: false };
  changeNickArgs: string[] = [];

  connected = false;
  connectCallCount = 0;
  quitCallCount = 0;
  whoCallCount = 0;
  sayArgs: Array<[string, string, Record<string, string> | undefined]> = [];

  connect(): void { this.connectCallCount++; }
  quit(_msg?: string): void { this.quitCallCount++; }
  say(target: string, body: string, tags?: Record<string, string>): void {
    this.sayArgs.push([target, body, tags]);
  }
  who(_target: string, _cb?: (e: { users: Array<{ nick: string; ident: string; hostname: string }> }) => void): void {
    this.whoCallCount++;
  }
  join(_channel: string): void {}
  tagmsg(_target: string, _tags?: Record<string, string>): void {}
  requestCap(_cap: string | string[]): void {}
  raw(_cmd: string, ..._args: string[]): void {}
  changeNick(nick: string): void { this.changeNickArgs.push(nick); }
}

interface MockHostResult {
  host: {
    onError(err: unknown, ctx: object): void;
    onWarning(message: string, ctx: object): void;
    onEvent(event: unknown): void;
  };
  errors: Array<[unknown, object]>;
  warnings: Array<[string, object]>;
  events: unknown[];
}

function makeMockHost(): MockHostResult {
  const errors: Array<[unknown, object]> = [];
  const warnings: Array<[string, object]> = [];
  const events: unknown[] = [];
  return {
    host: {
      onError(err: unknown, ctx: object) { errors.push([err, ctx]); },
      onWarning(message: string, ctx: object) { warnings.push([message, ctx]); },
      onEvent(event: unknown) { events.push(event); },
    },
    errors,
    warnings,
    events,
  };
}

/**
 * Build a minimal AccountRuntime and inject it into a provider WITHOUT calling
 * start() (which would open a real socket). Returns handles for the runtime, the
 * provider, and the mock host so tests can trigger events and inspect state.
 */
function injectRuntime(
  accountKey: string,
  client: MockClient,
  opts: { host?: MockHostResult; triggerHoldMs?: number; altNicks?: string[] } = {},
): {
  provider: IrcProvider;
  rt: Record<string, unknown>;
  host: MockHostResult;
} {
  const { host = makeMockHost(), triggerHoldMs, altNicks } = opts;

  const provider = new IrcProvider({
    enabled: true,
    trigger_hold_ms: triggerHoldMs,
    accounts: {
      [accountKey]: { host: "irc.example.net", nick: "testbot" },
    },
  });

  // Inject host and stopped flag via internal access (test seam; no production API).
  (provider as unknown as Record<string, unknown>).host = host.host;
  (provider as unknown as Record<string, unknown>).stopped = false;

  const rt: Record<string, unknown> = {
    accountId: accountKey,
    config: { host: "irc.example.net", nick: "testbot", channels: [], alt_nicks: altNicks },
    client,
    self: { id: "irc.example.net/testbot", username: "testbot" },
    capFailed: false,
    registered: false,
    capDelReconnect: false,
    nickCandidates: buildNickCandidates("testbot", altNicks),
    nickAttempt: 0,
    registering: true,
    nickExhaustedReconnect: false,
    giveUpReconnects: 0,
    casemapping: "rfc1459",
    networkName: "irc.example.net",
    networkIdFrozen: true, // freeze so inbound handlers (privmsg/notice/action) pass the gate
    nick: "testbot",
    username: "testbot",
    host: "",
    hasLabeledResponse: false,
    hasMsgid: false,
    echoQueues: new Map(),
    pendingByLabel: new Map(),
    accountTracker: new AccountTracker(),
    rosterTracker: new RosterTracker(),
    channelData: new Map<string, { topic?: string; modes?: string }>(),
  };

  // Inject the runtime into the accounts map and wire listeners.
  (
    (provider as unknown as Record<string, unknown>).accounts as Map<string, unknown>
  ).set(accountKey, rt);
  (provider as unknown as { attachListeners(rt: unknown): void }).attachListeners(rt);

  return { provider, rt, host };
}

// ── F7: floor-cap validation failure ──────────────────────────────────────────

test("F7: floor-cap validation failure sets capFailed and emits onError", () => {
  const client = new MockClient();
  // No caps enabled → server-time, message-tags, echo-message all missing.
  const { rt, host } = injectRuntime("acc", client);

  client.emit("registered", { nick: "testbot", tags: {} });

  assert.equal(rt.capFailed, true, "capFailed must be set after floor-cap failure");
  assert.equal(host.errors.length, 1, "onError must be called once");
  const [err, ctx] = host.errors[0]!;
  assert.ok(err instanceof Error, "error must be an Error instance");
  assert.match((err as Error).message, /required capability|floor/i, "error message must name the missing cap");
  assert.equal((ctx as Record<string, string>).phase, "floor_cap_validation");
});

test("F7: repeated registered events with capFailed do not re-emit onError", () => {
  const client = new MockClient();
  const { rt, host } = injectRuntime("acc", client);

  client.emit("registered", { nick: "testbot", tags: {} }); // sets capFailed
  assert.equal(host.errors.length, 1);

  client.emit("registered", { nick: "testbot", tags: {} }); // capFailed path: quit(), no new error
  assert.equal(host.errors.length, 1, "second registered after capFailed must not add errors");
});

// ── F1: socket close sets registered=false and drains echoes ─────────────────

test("F1: 'socket close' sets rt.registered to false", () => {
  const client = new MockClient();
  const { rt } = injectRuntime("acc", client);
  rt.registered = true;

  client.emit("socket close");

  assert.equal(rt.registered, false, "registered must be false after 'socket close'");
});

test("F1: send() rejects after 'socket close' (not-registered error)", async () => {
  const client = new MockClient();
  const { provider, rt } = injectRuntime("acc", client);
  rt.registered = true;

  client.emit("socket close"); // provider sees disconnection

  await assert.rejects(
    () =>
      provider.send(
        { provider: "irc", timelineKey: "irc:acc:room:#general" },
        { body: "hello", attachments: [] },
      ),
    /not registered/i,
    "send() must reject fast when !registered, not fabricate a receipt",
  );
});

test("F1: 'socket close' clears accountTracker (stale mappings must not survive reconnect)", () => {
  const client = new MockClient();
  client.network.cap.enabled = ["server-time", "message-tags", "echo-message"];
  const { rt } = injectRuntime("acc", client);
  rt.registered = true;

  // Seed the tracker via an account-notify event (as if user was identified).
  client.emit("account", {
    nick: "alice",
    ident: "alice",
    hostname: "h",
    account: "alice_services",
    tags: {},
    time: Date.now(),
  });

  const tracker = rt.accountTracker as AccountTracker;
  assert.equal(tracker.getAccount("alice", "rfc1459"), "alice_services", "pre-condition: tracker seeded");

  // Disconnect.
  client.emit("socket close");

  assert.equal(
    tracker.getAccount("alice", "rfc1459"),
    undefined,
    "socket close must clear stale nick→account mappings",
  );
});

// ── F2: CAP DEL required cap → capDelReconnect + reconnect on close ───────────

test("F2: CAP DEL required cap sets capDelReconnect and clears registered", () => {
  const client = new MockClient();
  client.network.cap.enabled = ["server-time", "message-tags", "echo-message"];
  const { rt } = injectRuntime("acc", client);
  rt.registered = true;

  client.emit("cap del", { capabilities: { "echo-message": "" }, command: "CAP" });

  assert.equal(rt.registered, false, "registered must be false after CAP DEL");
  assert.equal(rt.capDelReconnect, true, "capDelReconnect must be set");
  assert.equal(rt.capFailed, false, "capFailed must remain false (allow re-validation)");
});

test("F2: 'close' after capDelReconnect triggers client.connect()", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const client = new MockClient();
    client.network.cap.enabled = ["server-time", "message-tags", "echo-message"];
    const { rt } = injectRuntime("acc", client);
    rt.registered = true;

    // Simulate the CAP DEL + quit() + disconnect sequence.
    client.emit("cap del", { capabilities: { "server-time": "" }, command: "CAP" });
    client.emit("socket close"); // fired by quit() → socket tear-down
    client.emit("close");        // fired when library gives up (requested_disconnect=true)

    assert.equal(client.connectCallCount, 0, "connect() must not fire before the delay");

    mock.timers.tick(1001); // past the 1 s reconnect delay

    assert.equal(client.connectCallCount, 1, "connect() must be called once after delay");
    assert.equal(rt.capDelReconnect, false, "capDelReconnect must be reset");
  } finally {
    mock.timers.reset();
  }
});

test("F2: capFailed path after reconnect prevents further connect() calls", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const client = new MockClient();
    client.network.cap.enabled = ["server-time", "message-tags", "echo-message"];
    const { rt } = injectRuntime("acc", client);
    rt.registered = true;

    // First CAP DEL cycle: capDelReconnect set.
    client.emit("cap del", { capabilities: { "server-time": "" }, command: "CAP" });
    client.emit("socket close");
    client.emit("close");
    mock.timers.tick(1001); // reconnect fires → connect() called once

    assert.equal(client.connectCallCount, 1);

    // Simulate floor-cap failure on the reconnected session (cap still missing).
    // Set capFailed=true as validateFloorCaps would do, then emit close again.
    rt.capFailed = true;
    client.emit("socket close");
    client.emit("close");
    mock.timers.tick(5000);

    // No further connect() — capFailed terminates the reconnect loop permanently.
    assert.equal(client.connectCallCount, 1, "no second connect after capFailed");
  } finally {
    mock.timers.reset();
  }
});

// ── F2b: library gave up (failed first connect / retries exhausted) ──────────

test("F2b: 'close' with no reconnect flag reconnects with doubling backoff", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const client = new MockClient();
    const { rt } = injectRuntime("acc", client);

    client.emit("socket close");
    client.emit("close"); // the library gave up
    mock.timers.tick(14_999);
    assert.equal(client.connectCallCount, 0, "no connect before the 15 s base delay");
    mock.timers.tick(1);
    assert.equal(client.connectCallCount, 1, "connect after 15 s");

    client.emit("socket close");
    client.emit("close"); // that attempt failed too
    mock.timers.tick(29_999);
    assert.equal(client.connectCallCount, 1, "second delay doubles to 30 s");
    mock.timers.tick(1);
    assert.equal(client.connectCallCount, 2);
    assert.equal(rt.giveUpReconnects, 2);
  } finally {
    mock.timers.reset();
  }
});

test("F2b: backoff is capped at 300 s and resets on registration", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const client = new MockClient();
    client.network.cap.enabled = ["server-time", "message-tags", "echo-message"];
    const { rt } = injectRuntime("acc", client);
    rt.giveUpReconnects = 10; // 15 s × 2^10 would be far past the cap

    client.emit("close");
    mock.timers.tick(300_000);
    assert.equal(client.connectCallCount, 1, "delay capped at 300 s");

    client.emit("registered", { nick: "testbot" });
    assert.equal(rt.giveUpReconnects, 0, "a registered connection resets the backoff");
  } finally {
    mock.timers.reset();
  }
});

test("F2b: 'close' after stop() or a cap failure never reconnects", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const capClient = new MockClient();
    const { rt: capRt } = injectRuntime("cap", capClient);
    capRt.capFailed = true;
    capClient.emit("close");
    mock.timers.tick(600_000);
    assert.equal(capClient.connectCallCount, 0, "capFailed stops the loop");

    const client = new MockClient();
    const { provider } = injectRuntime("acc", client);
    await provider.stop();
    client.emit("close");
    mock.timers.tick(600_000);
    assert.equal(client.connectCallCount, 0, "a stopped provider never reconnects");
  } finally {
    mock.timers.reset();
  }
});

// ── F3: 'user updated' hostmask relearning ────────────────────────────────────

test("F3: 'user updated' for own nick triggers learnHostmask (WHO issued)", () => {
  const client = new MockClient();
  client.network.cap.enabled = ["server-time", "message-tags", "echo-message"];
  const { rt } = injectRuntime("acc", client);
  rt.registered = true;
  rt.nick = "testbot";

  client.emit("user updated", {
    nick: "testbot",
    ident: "testbot",
    hostname: "old.example.net",
    new_ident: "testbot",
    new_hostname: "new.vhost.example.net",
    tags: {},
    time: Date.now(),
  });

  assert.equal(client.whoCallCount, 1, "WHO must be issued to relearn hostmask for own nick");
});

test("F3: 'user updated' for another nick does not trigger learnHostmask", () => {
  const client = new MockClient();
  client.network.cap.enabled = ["server-time", "message-tags", "echo-message"];
  const { rt } = injectRuntime("acc", client);
  rt.registered = true;
  rt.nick = "testbot";

  client.emit("user updated", {
    nick: "alice",
    ident: "alice",
    hostname: "alice.example.net",
    new_ident: "alice",
    new_hostname: "alice.vhost.example.net",
    tags: {},
    time: Date.now(),
  });

  assert.equal(client.whoCallCount, 0, "WHO must NOT be issued for other users' CHGHOST");
});

// ── F5: trigger_hold_ms ───────────────────────────────────────────────────────

test("F5: trigger_hold_ms=0 → host.onEvent fires immediately for trigger-bearing message", () => {
  const client = new MockClient();
  client.network.cap.enabled = ["server-time", "message-tags", "echo-message"];
  const mockHost = makeMockHost();
  const { rt } = injectRuntime("acc", client, { host: mockHost, triggerHoldMs: 0 });
  rt.registered = true;

  // "testbot: hello" addressing prefix → mention trigger.
  client.emit("privmsg", {
    from_server: false,
    nick: "alice",
    ident: "alice",
    hostname: "alice.example.net",
    target: "#general",
    message: "testbot: hello",
    tags: {},
    time: Date.now(),
  });

  assert.equal(mockHost.events.length, 1, "event must fire synchronously with hold=0");
  assert.ok(
    (mockHost.events[0] as Record<string, unknown>).trigger,
    "event must carry a trigger",
  );
});

function holdHarness(holdMs: number) {
  const client = new MockClient();
  client.network.cap.enabled = ["server-time", "message-tags", "echo-message"];
  const mockHost = makeMockHost();
  const { rt } = injectRuntime("acc", client, { host: mockHost, triggerHoldMs: holdMs });
  rt.registered = true;
  let seq = 0;
  const privmsg = (message: string, nick = "alice") =>
    client.emit("privmsg", {
      from_server: false,
      nick,
      ident: nick,
      hostname: `${nick}.example.net`,
      target: "#general",
      message,
      tags: { msgid: `m${++seq}` },
      time: Date.now(),
    });
  type Ev = { event: { id: string; body: string; trigger?: unknown }; trigger?: { groupedEventIds?: string[]; holdEndedAt?: number } };
  const events = () => mockHost.events as Ev[];
  const triggers = () => events().filter((e) => e.trigger);
  return { privmsg, events, triggers };
}

test("F5: trigger_hold_ms>0 → every held message is emitted (stored) at once; one trigger groups the sender's messages", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const t = holdHarness(200);
    t.privmsg("testbot: first");
    t.privmsg("and a detail"); // not addressed: joins the hold
    t.privmsg("testbot: second");

    // Every message is emitted untriggered as it arrives (never lost to a newer one).
    assert.deepEqual(t.events().map((e) => [e.event.body, e.trigger]), [
      ["testbot: first", undefined],
      ["and a detail", undefined],
      ["testbot: second", undefined],
    ]);
    assert.equal(t.triggers().length, 0, "no trigger before the hold expires");

    mock.timers.tick(250);

    assert.equal(t.triggers().length, 1, "exactly one trigger after the hold");
    const [held] = t.triggers();
    assert.match(held!.event.body, /first/, "rooted on the hold's first message");
    assert.deepEqual(held!.trigger!.groupedEventIds, t.events().slice(0, 3).map((e) => e.event.id));
    assert.equal(held!.event.trigger, held!.trigger);
    assert.ok(held!.trigger!.holdEndedAt);
  } finally {
    mock.timers.reset();
  }
});

test("F5: trigger_hold_ms>0 → each sender has their own hold: another sender's trigger never replaces a held one", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const t = holdHarness(200);
    t.privmsg("testbot: alice asks", "alice");
    t.privmsg("testbot: bob asks", "bob");
    mock.timers.tick(250);
    assert.deepEqual(t.triggers().map((e) => e.event.body).sort(), ["testbot: alice asks", "testbot: bob asks"]);
    assert.ok(t.triggers().every((e) => e.trigger!.groupedEventIds!.length === 1));
  } finally {
    mock.timers.reset();
  }
});

test("F5: trigger_hold_ms>0 → a trigger-bearing follow-up extends the hold, capped from its start", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const t = holdHarness(200);
    t.privmsg("testbot: one");
    mock.timers.tick(150);
    t.privmsg("testbot: two");
    mock.timers.tick(150);
    assert.equal(t.triggers().length, 0, "extended by the second trigger");
    mock.timers.tick(100);
    assert.equal(t.triggers().length, 1);
    // A non-addressed message alone never opens a hold.
    t.privmsg("just chatting", "carol");
    mock.timers.tick(1000);
    assert.equal(t.triggers().length, 1);
  } finally {
    mock.timers.reset();
  }
});

// ── F7: echo-merge and echo timeout ──────────────────────────────────────────

test("F7: echo-merge resolves receipt with server-assigned msgid", async () => {
  const client = new MockClient();
  client.network.cap.enabled = ["server-time", "message-tags", "echo-message"];
  const { provider, rt } = injectRuntime("acc", client);
  rt.registered = true;

  // When say() is called, fire the server echo with a real msgid.
  client.say = (target: string, body: string) => {
    setImmediate(() => {
      client.emit("privmsg", {
        from_server: false,
        nick: "testbot", // self-echo
        ident: "testbot",
        hostname: "example.net",
        target,
        message: body,
        tags: { msgid: "server-real-msgid" },
        time: Date.now(),
      });
    });
  };

  const receipt = await provider.send(
    { provider: "irc", timelineKey: "irc:acc:room:#general" },
    { body: "hello world", attachments: [] },
  );

  assert.equal(receipt.externalId, "server-real-msgid", "receipt must use server msgid from echo");
});

test("F7: echo timeout produces synthetic id (syn: prefix)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const client = new MockClient();
    client.network.cap.enabled = ["server-time", "message-tags", "echo-message"];
    // say() is a no-op → no echo will arrive.
    client.say = () => {};
    const { provider, rt } = injectRuntime("acc", client);
    rt.registered = true;

    const sendPromise = provider.send(
      { provider: "irc", timelineKey: "irc:acc:room:#general" },
      { body: "hello", attachments: [] },
    );

    // Advance past ECHO_TIMEOUT_MS (5000 ms).
    mock.timers.tick(5001);

    const receipt = await sendPromise;
    assert.match(receipt.externalId ?? "", /^syn:/, "timed-out receipt must use synthetic id");
  } finally {
    mock.timers.reset();
  }
});

// ── Enrichment capabilities (merge-review fix) ────────────────────────────────

describe("IrcProvider enrichment capabilities", () => {
  test("enrichment() returns capabilities for a known account, undefined otherwise", () => {
    const client = new MockClient();
    const { provider } = injectRuntime("acc", client);
    assert.ok(provider.enrichment("acc"), "known account must get enrichment capabilities");
    assert.equal(provider.enrichment("nope"), undefined, "unknown account must get undefined");
  });

  test("enrichment() omits resolveLinkPreviews so the direct-HTTP fallback runs (§7.7)", () => {
    const client = new MockClient();
    const { provider } = injectRuntime("acc", client);
    const caps = provider.enrichment("acc");
    assert.ok(caps);
    assert.equal(caps.resolveLinkPreviews, undefined, "linkPreviews 'none' → method must be absent");
  });

  test("enrichment().messageSummary returns null and downloadMedia rejects", async () => {
    const client = new MockClient();
    const { provider } = injectRuntime("acc", client);
    const caps = provider.enrichment("acc");
    assert.ok(caps);
    assert.equal(await caps.messageSummary({ roomId: "#general", eventId: "e1" }), null);
    await assert.rejects(
      caps.downloadMedia({ roomId: "#general", eventId: "e1", outputPath: "/dev/null" }),
      /no attachments/,
    );
  });

  test("enrichment().memberInfo resolves network-scoped account id to current nick via roster", async () => {
    const client = new MockClient();
    const { provider, rt } = injectRuntime("acc", client);
    const roster = rt.rosterTracker as InstanceType<typeof RosterTracker>;
    const tracker = rt.accountTracker as AccountTracker;
    roster.addMember("#general", "Alice", "rfc1459");
    tracker.setAccount("Alice", "alice_svc", "rfc1459");

    const caps = provider.enrichment("acc");
    assert.ok(caps);
    // By network-scoped services account → current nick.
    const byAccount = await caps.memberInfo({ roomId: "#general", userId: "irc.example.net/alice_svc" });
    assert.equal(byAccount.displayName, "Alice");
    // By network-scoped nick (ladder rung 3 id) → roster nick.
    const byNick = await caps.memberInfo({ roomId: "#general", userId: "irc.example.net/alice" });
    assert.equal(byNick.displayName, "Alice");
    // Unknown → undefined displayName (scoped ghost not in roster).
    const missing = await caps.memberInfo({ roomId: "#general", userId: "irc.example.net/ghost" });
    assert.equal(missing.displayName, undefined);
    // Bare (unscoped) id → mismatched prefix → undefined displayName.
    const bare = await caps.memberInfo({ roomId: "#general", userId: "alice_svc" });
    assert.equal(bare.displayName, undefined, "bare unscoped id must not match");
  });
});

// ── Network-scoped id round-trips (scoped-id verifier fixes) ──────────────────

describe("network-scoped ids: outbound round-trips", () => {
  test("DM send strips the network scope from the wire target", async () => {
    const client = new MockClient();
    client.network.cap.enabled = ["server-time", "message-tags", "echo-message"];
    const { provider, rt } = injectRuntime("acc", client);
    rt.registered = true;

    const sayTargets: string[] = [];
    client.say = (target: string, body: string) => {
      sayTargets.push(target);
      setImmediate(() => {
        client.emit("privmsg", {
          from_server: false,
          nick: "testbot",
          ident: "testbot",
          hostname: "example.net",
          target, // real servers echo the bare nick target
          message: body,
          tags: { msgid: "dm-echo-msgid" },
          time: Date.now(),
        });
      });
    };

    const receipt = await provider.send(
      { provider: "irc", timelineKey: "irc:acc:dm:irc.example.net/alice" },
      { body: "hi alice", attachments: [] },
    );

    assert.deepEqual(sayTargets, ["alice"], "PRIVMSG target must be the bare nick, not the scoped id");
    assert.equal(receipt.externalId, "dm-echo-msgid", "echo must correlate without timing out");
  });

  test("setTyping strips the network scope from the TAGMSG target", async () => {
    const client = new MockClient();
    client.network.cap.enabled = ["server-time", "message-tags", "echo-message"];
    const { provider, rt } = injectRuntime("acc", client);
    rt.registered = true;

    const tagmsgTargets: string[] = [];
    client.tagmsg = (target: string) => {
      tagmsgTargets.push(target);
    };

    await provider.setTyping(
      { provider: "irc", timelineKey: "irc:acc:dm:irc.example.net/alice" },
      true,
    );
    await provider.setTyping(
      { provider: "irc", timelineKey: "irc:acc:dm:irc.example.net/alice" },
      false,
    );

    assert.ok(tagmsgTargets.length >= 1, "tagmsg must fire");
    for (const t of tagmsgTargets) {
      assert.equal(t, "alice", "TAGMSG target must be the bare nick");
    }
  });

  test("channelInfo on a DM shows the bare identity, not the scoped id", async () => {
    const client = new MockClient();
    const { provider } = injectRuntime("acc", client);

    const ch = provider.channelClient({
      provider: "irc",
      timelineKey: "irc:acc:dm:irc.example.net/alice",
    });
    assert.ok(ch);
    const info = await ch.channelInfo({ roomId: "irc.example.net/alice" });
    assert.equal(info.displayName, "alice");
    assert.match(info.label ?? "", /^alice /, "label must lead with the bare identity");
  });

  test("ownsUserId requires non-empty network and identity components", () => {
    const client = new MockClient();
    const { provider } = injectRuntime("acc", client);
    assert.equal(provider.ownsUserId("libera.chat/alice"), true);
    assert.equal(provider.ownsUserId("/alice"), false, "empty network component");
    assert.equal(provider.ownsUserId("libera.chat/"), false, "empty identity component");
  });
});

// ── N: nick fallback, reclaim and reconnect reset ────────────────────────────

const FLOOR = ["server-time", "message-tags", "echo-message"];
const RETRY_MS = 180_000;

function inUse(client: MockClient, nick: string): void {
  client.emit("nick in use", { nick, reason: "Nickname is already in use", tags: {} });
}

test("N0: buildNickCandidates orders primary, alt_nicks, generated; drops casemapped duplicates", () => {
  assert.deepEqual(buildNickCandidates("mikubot", ["mikubot2", "MikuBot_", "other"]), [
    "mikubot",
    "mikubot2",
    "MikuBot_",
    "other",
    "mikubot__",
    "mikubot1",
    "mikubot3",
  ]);
  assert.deepEqual(buildNickCandidates("mikubot"), [
    "mikubot",
    "mikubot_",
    "mikubot__",
    "mikubot1",
    "mikubot2",
    "mikubot3",
  ]);
});

test("N1: primary nick in use during registration → first alt_nick, logged at warn", () => {
  const client = new MockClient();
  const { host } = injectRuntime("acc", client, { altNicks: ["altbot", "altbot2"] });

  inUse(client, "testbot");

  assert.deepEqual(client.changeNickArgs, ["altbot"]);
  assert.equal(host.warnings.length, 1);
  const [msg, ctx] = host.warnings[0]!;
  assert.match(msg, /"acc"/);
  assert.match(msg, /"testbot".*"altbot"/);
  assert.equal((ctx as Record<string, string>).accountId, "acc");
  assert.equal(host.errors.length, 0);
});

test("N2: alt_nicks exhausted → generated fallbacks derived from the primary", () => {
  const client = new MockClient();
  injectRuntime("acc", client, { altNicks: ["altbot"] });

  inUse(client, "testbot");
  inUse(client, "altbot");
  inUse(client, "testbot_");

  assert.deepEqual(client.changeNickArgs, ["altbot", "testbot_", "testbot__"]);
});

test("N3: every candidate refused → one error, QUIT, bounded attempts, reconnect after the retry interval", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const client = new MockClient();
    const { rt, host } = injectRuntime("acc", client);
    const candidates = rt.nickCandidates as string[];

    // Far more rejections than candidates: must not loop.
    for (let i = 0; i < 50; i++) inUse(client, "x");

    assert.equal(client.changeNickArgs.length, candidates.length - 1, "one NICK per fallback, no more");
    assert.equal(host.errors.length, 1, "exhaustion is logged once");
    assert.match((host.errors[0]![0] as Error).message, /refused every candidate nick/);
    assert.equal(client.quitCallCount, 1);

    client.emit("socket close");
    client.emit("close");
    mock.timers.tick(RETRY_MS - 1);
    assert.equal(client.connectCallCount, 0, "no reconnect before the retry interval");
    mock.timers.tick(1);
    assert.equal(client.connectCallCount, 1, "reconnects once after the retry interval");
  } finally {
    mock.timers.reset();
  }
});

test("N4: 432 on the primary is reported as a misconfiguration, then alt_nicks are tried", () => {
  const client = new MockClient();
  const { host } = injectRuntime("acc", client, { altNicks: ["altbot"] });

  client.emit("nick invalid", { nick: "testbot", reason: "Erroneous Nickname", tags: {} });

  assert.equal(host.errors.length, 1);
  assert.match((host.errors[0]![0] as Error).message, /erroneous.*irc\.accounts\.acc\]\.nick/);
  assert.deepEqual(client.changeNickArgs, ["altbot"]);
});

test("N5: 437 for a nick advances; 437 for a channel and unrelated numerics are ignored", () => {
  const client = new MockClient();
  injectRuntime("acc", client, { altNicks: ["altbot"] });

  client.emit("unknown command", { command: "437", params: ["*", "#chan", "Channel is temporarily unavailable"], tags: {} });
  client.emit("unknown command", { command: "999", params: ["*", "testbot", "whatever"], tags: {} });
  assert.deepEqual(client.changeNickArgs, []);

  client.emit("unknown command", { command: "437", params: ["*", "testbot", "Nick is temporarily unavailable"], tags: {} });
  assert.deepEqual(client.changeNickArgs, ["altbot"]);
});

test("N6: registered on a fallback → periodic reclaim; 433 on reclaim is silent; success goes through the own-nick path", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const client = new MockClient();
    client.network.cap.enabled = [...FLOOR];
    const { rt, host } = injectRuntime("acc", client);

    inUse(client, "testbot");
    client.emit("registered", { nick: "testbot_", tags: {} });
    assert.equal(rt.registered, true);
    assert.equal(rt.nick, "testbot_");
    assert.ok(rt.reclaimTimer, "reclaim timer started");
    const warningsAfterRegister = host.warnings.length;

    mock.timers.tick(RETRY_MS);
    assert.equal(client.changeNickArgs.at(-1), "testbot", "reclaim requests the configured nick");
    const nickCalls = client.changeNickArgs.length;

    // Holder still there: the reply is 433 — stay put, no new NICK, no logs.
    inUse(client, "testbot");
    assert.equal(client.changeNickArgs.length, nickCalls);
    assert.equal(host.warnings.length, warningsAfterRegister);
    assert.equal(host.errors.length, 0);
    assert.equal(rt.nick, "testbot_");

    // Next tick succeeds: our own NICK echo.
    mock.timers.tick(RETRY_MS);
    const whoBefore = client.whoCallCount;
    client.emit("nick", { nick: "testbot_", new_nick: "testbot", ident: "u", hostname: "h", tags: {} });
    assert.equal(rt.nick, "testbot");
    assert.deepEqual(rt.self, { id: "irc.example.net/testbot", username: "testbot" });
    assert.equal(client.whoCallCount, whoBefore + 1, "hostmask re-learned for the new nick length");
    assert.equal(rt.reclaimTimer, undefined, "reclaim stops once the nick is back");

    const after = client.changeNickArgs.length;
    mock.timers.tick(RETRY_MS * 3);
    assert.equal(client.changeNickArgs.length, after, "no further reclaim attempts");
  } finally {
    mock.timers.reset();
  }
});

test("N7: holder QUITs or renames away → immediate reclaim attempt", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const client = new MockClient();
    client.network.cap.enabled = [...FLOOR];
    injectRuntime("acc", client);
    client.emit("registered", { nick: "testbot_", tags: {} });

    client.emit("quit", { nick: "TestBot", ident: "u", hostname: "h", message: "Ping timeout", tags: {} });
    assert.deepEqual(client.changeNickArgs, ["testbot"]);

    client.emit("nick", { nick: "testbot", new_nick: "someone", ident: "u", hostname: "h", tags: {} });
    assert.deepEqual(client.changeNickArgs, ["testbot", "testbot"]);

    // Unrelated users do not trigger an attempt.
    client.emit("quit", { nick: "alice", ident: "u", hostname: "h", message: "bye", tags: {} });
    assert.equal(client.changeNickArgs.length, 2);
  } finally {
    mock.timers.reset();
  }
});

test("N8: registered on the primary → no reclaim timer, no warning", () => {
  const client = new MockClient();
  client.network.cap.enabled = [...FLOOR];
  const { rt, host } = injectRuntime("acc", client);
  client.emit("registered", { nick: "testbot", tags: {} });
  assert.equal(rt.reclaimTimer, undefined);
  assert.equal(host.warnings.length, 0);
});

test("N9: every reconnect starts again from the configured nick", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const client = new MockClient();
    client.network.cap.enabled = [...FLOOR];
    const { rt } = injectRuntime("acc", client, { altNicks: ["altbot"] });

    inUse(client, "testbot");
    client.emit("registered", { nick: "altbot", tags: {} });
    // The library sets user.nick from RPL_WELCOME and its auto-reconnect
    // re-sends it, so this is what the next NICK would be without the reset.
    client.user.nick = "altbot";
    assert.ok(rt.reclaimTimer);

    client.emit("socket close");
    assert.equal(rt.reclaimTimer, undefined, "socket close clears the reclaim timer");

    client.emit("connecting"); // library auto-reconnect
    assert.equal(client.user.nick, "testbot", "registration NICK is the configured nick");
    assert.equal(rt.nickAttempt, 0);
    assert.equal(rt.registering, true);

    inUse(client, "testbot");
    assert.deepEqual(client.changeNickArgs, ["altbot", "altbot"], "fallback order restarts from the top");
  } finally {
    mock.timers.reset();
  }
});

test("N10: stop() clears the reclaim timer", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const client = new MockClient();
    client.network.cap.enabled = [...FLOOR];
    const { provider, rt } = injectRuntime("acc", client);
    client.emit("registered", { nick: "testbot_", tags: {} });
    assert.ok(rt.reclaimTimer);
    await provider.stop();
    assert.equal(rt.reclaimTimer, undefined);
    mock.timers.tick(RETRY_MS * 2);
    assert.deepEqual(client.changeNickArgs, []);
  } finally {
    mock.timers.reset();
  }
});
