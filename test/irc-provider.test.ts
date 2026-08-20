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
 */

import assert from "node:assert/strict";
import test, { describe, mock } from "node:test";
import { EventEmitter } from "node:events";
import { IrcProvider } from "../src/irc/provider.js";
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
}

interface MockHostResult {
  host: {
    onError(err: unknown, ctx: object): void;
    onEvent(event: unknown): void;
  };
  errors: Array<[unknown, object]>;
  events: unknown[];
}

function makeMockHost(): MockHostResult {
  const errors: Array<[unknown, object]> = [];
  const events: unknown[] = [];
  return {
    host: {
      onError(err: unknown, ctx: object) { errors.push([err, ctx]); },
      onEvent(event: unknown) { events.push(event); },
    },
    errors,
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
  opts: { host?: MockHostResult; triggerHoldMs?: number } = {},
): {
  provider: IrcProvider;
  rt: Record<string, unknown>;
  host: MockHostResult;
} {
  const { host = makeMockHost(), triggerHoldMs } = opts;

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
    config: { host: "irc.example.net", nick: "testbot", channels: [] },
    client,
    self: { id: "irc.example.net/testbot", username: "testbot" },
    capFailed: false,
    registered: false,
    capDelReconnect: false,
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

test("F5: trigger_hold_ms>0 → rapid trigger-bearing messages coalesce; flush emits last event", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const client = new MockClient();
    client.network.cap.enabled = ["server-time", "message-tags", "echo-message"];
    const mockHost = makeMockHost();
    const { rt } = injectRuntime("acc", client, { host: mockHost, triggerHoldMs: 200 });
    rt.registered = true;

    const privmsg = (message: string) =>
      client.emit("privmsg", {
        from_server: false,
        nick: "alice",
        ident: "alice",
        hostname: "alice.example.net",
        target: "#general",
        message,
        tags: {},
        time: Date.now(),
      });

    privmsg("testbot: first");
    privmsg("testbot: second");

    // No flush yet — still inside the hold window.
    assert.equal(mockHost.events.length, 0, "no event before hold expires");

    // Advance past the hold.
    mock.timers.tick(250);

    assert.equal(mockHost.events.length, 1, "exactly one event flushed after hold");
    const flushed = mockHost.events[0] as { event: { body: string }; trigger: unknown };
    assert.ok(flushed.trigger, "flushed event must have a trigger");
    assert.match(flushed.event.body, /second/, "last event body must be preserved on flush");
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
