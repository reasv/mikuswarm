/**
 * Phase 2 IRC identity tests — spec §5.1 (ladder), §5.3 (user_identities),
 * §5.4 (renames), §4 (DM key), §3.2 (account tracking via extended-join /
 * account-notify / WHOX / account-tag).
 *
 * Coverage groups:
 *   A. AccountTracker — pure state-machine unit tests
 *   B. resolveIrcSenderId — identity ladder function
 *   C. normalizeIrcMessage — ladder integration + DM key
 *   D. IrcProvider event handlers — join (extended-join + WHOX), account
 *      (account-notify), quit (prune), nick (rename tracking + alias callback)
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { EventEmitter } from "node:events";

import { AccountTracker } from "../src/irc/account-tracker.js";
import { RosterTracker } from "../src/irc/roster-tracker.js";
import {
  resolveIrcSenderId,
  normalizeIrcMessage,
  _resetCounters,
} from "../src/irc/normalizer.js";
import { IrcProvider, type IrcProviderCallbacks } from "../src/irc/provider.js";
import type { IrcConfig } from "../src/config/schema.js";
import type { UserIdentityUpsertInput } from "../src/storage/database.js";

// ── A. AccountTracker ─────────────────────────────────────────────────────────

describe("AccountTracker", () => {
  test("setAccount / getAccount: basic round-trip", () => {
    const tracker = new AccountTracker();
    tracker.setAccount("Alice", "Alice_Account", "ascii");
    assert.equal(tracker.getAccount("alice", "ascii"), "Alice_Account");
    assert.equal(tracker.getAccount("Alice", "ascii"), "Alice_Account");
  });

  test("setAccount: no-op for empty account string", () => {
    const tracker = new AccountTracker();
    tracker.setAccount("bob", "", "ascii");
    assert.equal(tracker.getAccount("bob", "ascii"), undefined);
  });

  test("getAccount: returns undefined for unknown nick", () => {
    const tracker = new AccountTracker();
    assert.equal(tracker.getAccount("nobody", "ascii"), undefined);
  });

  test("clearAccount: removes entry", () => {
    const tracker = new AccountTracker();
    tracker.setAccount("carol", "carolacct", "ascii");
    tracker.clearAccount("carol", "ascii");
    assert.equal(tracker.getAccount("carol", "ascii"), undefined);
  });

  test("clearAccount: no-op when nick not tracked", () => {
    const tracker = new AccountTracker();
    assert.doesNotThrow(() => tracker.clearAccount("nobody", "ascii"));
  });

  test("renameNick: account association moves from old nick to new nick", () => {
    const tracker = new AccountTracker();
    tracker.setAccount("dave", "daveacct", "ascii");
    tracker.renameNick("dave", "dave_", "ascii");
    assert.equal(tracker.getAccount("dave_", "ascii"), "daveacct");
    assert.equal(tracker.getAccount("dave", "ascii"), undefined);
  });

  test("renameNick: no-op when old nick has no tracked account", () => {
    const tracker = new AccountTracker();
    tracker.renameNick("nobody", "nobody_", "ascii");
    assert.equal(tracker.getAccount("nobody_", "ascii"), undefined);
  });

  test("removeNick: clears entry (QUIT semantics)", () => {
    const tracker = new AccountTracker();
    tracker.setAccount("eve", "eveacct", "ascii");
    tracker.removeNick("eve", "ascii");
    assert.equal(tracker.getAccount("eve", "ascii"), undefined);
  });

  test("removeNick: no-op when nick not tracked", () => {
    const tracker = new AccountTracker();
    assert.doesNotThrow(() => tracker.removeNick("nobody", "ascii"));
  });

  test("casemapping: rfc1459 — [Nick] and {nick} are the same key", () => {
    const tracker = new AccountTracker();
    tracker.setAccount("[Nick]", "NickAccount", "rfc1459");
    // {nick} is the rfc1459 casefold of [Nick]
    assert.equal(tracker.getAccount("{nick}", "rfc1459"), "NickAccount");
  });

  test("bulkUpdateFromWhox: non-empty account string → sets entry", () => {
    const tracker = new AccountTracker();
    tracker.bulkUpdateFromWhox([{ nick: "frank", account: "frankacct" }], "ascii");
    assert.equal(tracker.getAccount("frank", "ascii"), "frankacct");
  });

  test("bulkUpdateFromWhox: empty string → clears entry (WHOX '0' = not identified)", () => {
    const tracker = new AccountTracker();
    tracker.setAccount("grace", "graceacct", "ascii");
    tracker.bulkUpdateFromWhox([{ nick: "grace", account: "" }], "ascii");
    assert.equal(tracker.getAccount("grace", "ascii"), undefined);
  });

  test("bulkUpdateFromWhox: undefined account → skips (non-WHOX WHO response)", () => {
    const tracker = new AccountTracker();
    tracker.setAccount("henry", "henryacct", "ascii");
    tracker.bulkUpdateFromWhox([{ nick: "henry", account: undefined }], "ascii");
    // Entry must NOT be cleared when account is undefined (non-WHOX)
    assert.equal(tracker.getAccount("henry", "ascii"), "henryacct");
  });

  test("bulkUpdateFromWhox: mixed users — some with accounts, some without", () => {
    const tracker = new AccountTracker();
    tracker.bulkUpdateFromWhox([
      { nick: "ida", account: "idaacct" },
      { nick: "jack", account: "" },
      { nick: "kim", account: undefined },
    ], "ascii");
    assert.equal(tracker.getAccount("ida", "ascii"), "idaacct");
    assert.equal(tracker.getAccount("jack", "ascii"), undefined);
    assert.equal(tracker.getAccount("kim", "ascii"), undefined);
  });
});

// ── B. resolveIrcSenderId — identity ladder ────────────────────────────────────

describe("resolveIrcSenderId (identity ladder §5.1)", () => {
  test("Rung 1: per-message account-tag present → uses account name", () => {
    const tracker = new AccountTracker();
    const id = resolveIrcSenderId("alice", "alice_account", tracker, "ascii");
    assert.equal(id, "alice_account");
  });

  test("Rung 1 wins over tracked state: tag overrides stale tracker", () => {
    const tracker = new AccountTracker();
    tracker.setAccount("alice", "old_account", "ascii");
    const id = resolveIrcSenderId("alice", "new_account_from_tag", tracker, "ascii");
    assert.equal(id, "new_account_from_tag");
  });

  test("Rung 1 absent: falls to Rung 2 (tracked state)", () => {
    const tracker = new AccountTracker();
    tracker.setAccount("bob", "bobacct", "ascii");
    const id = resolveIrcSenderId("bob", undefined, tracker, "ascii");
    assert.equal(id, "bobacct");
  });

  test("Rung 2 absent: falls to Rung 3 (casemapped nick)", () => {
    const tracker = new AccountTracker();
    const id = resolveIrcSenderId("Carol", undefined, tracker, "ascii");
    assert.equal(id, "carol");
  });

  test("account-tag '*' (defensive): treated as absent → falls to tracker, then nick", () => {
    const tracker = new AccountTracker();
    // No tracked state for dave
    const id = resolveIrcSenderId("dave", "*", tracker, "ascii");
    assert.equal(id, "dave");
  });

  test("account-tag '*' with tracked state: uses tracked state (tag='*' = absent)", () => {
    const tracker = new AccountTracker();
    tracker.setAccount("eve", "eveacct", "ascii");
    const id = resolveIrcSenderId("eve", "*", tracker, "ascii");
    assert.equal(id, "eveacct");
  });

  test("no tracker at all: falls to casemapped nick", () => {
    const id = resolveIrcSenderId("Frank", undefined, undefined, "ascii");
    assert.equal(id, "frank");
  });

  test("rfc1459 casemapping applied to nick fallback", () => {
    const id = resolveIrcSenderId("[Nick]", undefined, undefined, "rfc1459");
    assert.equal(id, "{nick}");
  });
});

// ── C. normalizeIrcMessage — ladder + DM key ────────────────────────────────────

describe("normalizeIrcMessage: identity ladder integration", () => {
  test("account-tag present → sender.id = account name, username = nick", () => {
    _resetCounters();
    const tracker = new AccountTracker();
    const ctx = {
      accountId: "acc",
      selfNick: "bot",
      casemapping: "ascii",
      accountTracker: tracker,
    };
    const msg = {
      nick: "alice",
      ident: "a",
      hostname: "h",
      target: "#chan",
      message: "hello",
      tags: {},
      time: 1_000_000,
      account: "alice_services",
    };
    const inbound = normalizeIrcMessage(msg, ctx);
    assert.equal(inbound.event.sender.id, "alice_services");
    assert.equal(inbound.event.sender.username, "alice");
  });

  test("no account-tag but tracked account → sender.id = tracked account", () => {
    _resetCounters();
    const tracker = new AccountTracker();
    tracker.setAccount("bob", "bob_services", "ascii");
    const ctx = {
      accountId: "acc",
      selfNick: "bot",
      casemapping: "ascii",
      accountTracker: tracker,
    };
    const msg = {
      nick: "bob",
      ident: "b",
      hostname: "h",
      target: "#chan",
      message: "hi",
      tags: {},
      time: 1_000_000,
      account: undefined,
    };
    const inbound = normalizeIrcMessage(msg, ctx);
    assert.equal(inbound.event.sender.id, "bob_services");
    assert.equal(inbound.event.sender.username, "bob");
  });

  test("no account-tag, no tracker → sender.id = casemapped nick", () => {
    _resetCounters();
    const ctx = { accountId: "acc", selfNick: "bot", casemapping: "ascii" };
    const msg = {
      nick: "Carol",
      ident: "c",
      hostname: "h",
      target: "#chan",
      message: "yo",
      tags: {},
      time: 1_000_000,
      account: undefined,
    };
    const inbound = normalizeIrcMessage(msg, ctx);
    assert.equal(inbound.event.sender.id, "carol");
  });

  test("self message with sasl_user configured → sender.id = SASL account", () => {
    _resetCounters();
    const ctx = {
      accountId: "acc",
      selfNick: "bot",
      casemapping: "ascii",
      selfAccount: "bot_services",
    };
    const msg = {
      nick: "bot",
      ident: "b",
      hostname: "h",
      target: "#chan",
      message: "I said something",
      tags: { msgid: "self-echo-id" },
      time: 1_000_000,
      account: undefined,
    };
    const inbound = normalizeIrcMessage(msg, ctx);
    assert.equal(inbound.event.sender.id, "bot_services");
    assert.equal(inbound.event.sender.username, "bot");
    assert.equal(inbound.event.sender.isSelf, true);
  });

  test("self message without sasl_user → sender.id = casemapped nick", () => {
    _resetCounters();
    const ctx = { accountId: "acc", selfNick: "bot", casemapping: "ascii" };
    const msg = {
      nick: "bot",
      ident: "b",
      hostname: "h",
      target: "#chan",
      message: "echo",
      tags: {},
      time: 1_000_000,
      account: undefined,
    };
    const inbound = normalizeIrcMessage(msg, ctx);
    assert.equal(inbound.event.sender.id, "bot");
    assert.equal(inbound.event.sender.isSelf, true);
  });
});

describe("normalizeIrcMessage: DM key is ladder-aware (spec §4)", () => {
  test("DM with account-tag → key uses account name", () => {
    _resetCounters();
    const ctx = { accountId: "acc", selfNick: "bot", casemapping: "ascii" };
    const msg = {
      nick: "alice",
      ident: "a",
      hostname: "h",
      target: "bot",
      message: "hey",
      tags: {},
      time: 1_000_000,
      account: "alice_acct",
    };
    const inbound = normalizeIrcMessage(msg, ctx);
    assert.equal(inbound.timelineKey, "irc:acc:dm:alice_acct");
  });

  test("DM with tracked account → key uses tracked account", () => {
    _resetCounters();
    const tracker = new AccountTracker();
    tracker.setAccount("bob", "bob_acct", "ascii");
    const ctx = {
      accountId: "acc",
      selfNick: "bot",
      casemapping: "ascii",
      accountTracker: tracker,
    };
    const msg = {
      nick: "bob",
      ident: "b",
      hostname: "h",
      target: "bot",
      message: "hello",
      tags: {},
      time: 1_000_000,
      account: undefined,
    };
    const inbound = normalizeIrcMessage(msg, ctx);
    assert.equal(inbound.timelineKey, "irc:acc:dm:bob_acct");
  });

  test("DM with no account/tracker → key uses casemapped nick", () => {
    _resetCounters();
    const ctx = { accountId: "acc", selfNick: "bot", casemapping: "ascii" };
    const msg = {
      nick: "Carol",
      ident: "c",
      hostname: "h",
      target: "bot",
      message: "hey",
      tags: {},
      time: 1_000_000,
      account: undefined,
    };
    const inbound = normalizeIrcMessage(msg, ctx);
    assert.equal(inbound.timelineKey, "irc:acc:dm:carol");
  });

  test("trigger.triggeredBy.id uses ladder result (account, not nick)", () => {
    _resetCounters();
    const tracker = new AccountTracker();
    tracker.setAccount("dave", "dave_acct", "ascii");
    const ctx = {
      accountId: "acc",
      selfNick: "bot",
      casemapping: "ascii",
      accountTracker: tracker,
    };
    const msg = {
      nick: "dave",
      ident: "d",
      hostname: "h",
      target: "bot",
      message: "hey",
      tags: {},
      time: 1_000_000,
      account: undefined,
    };
    const inbound = normalizeIrcMessage(msg, ctx);
    assert.equal(inbound.trigger?.triggeredBy.id, "dave_acct");
    assert.equal(inbound.trigger?.triggeredBy.username, "dave");
  });
});

// ── D. IrcProvider event handlers ────────────────────────────────────────────

/**
 * Minimal mock irc-framework client that is an EventEmitter with the
 * stubbed methods the provider's listeners need.
 */
class MockClient extends EventEmitter {
  network: {
    cap: { enabled: string[]; isEnabled(cap: string): boolean };
    supports(name: string): string | boolean | undefined;
  } = {
    cap: {
      enabled: ["server-time", "message-tags", "echo-message"],
      isEnabled(cap: string) {
        return this.enabled.includes(cap);
      },
    },
    supports(_name: string) { return undefined; },
  };
  connected = false;
  sayArgs: Array<[string, string, unknown]> = [];
  whoCallCount = 0;
  whoCallback?: (e: { target: string; users: Array<{ nick: string; account?: string }> }) => void;

  connect(): void { /* no-op */ }
  quit(_msg?: string): void { /* no-op */ }
  say(t: string, m: string, tags?: unknown): void { this.sayArgs.push([t, m, tags]); }
  who(_target: string, cb?: (e: { target: string; users: Array<{ nick: string; account?: string }> }) => void): void {
    this.whoCallCount++;
    this.whoCallback = cb;
  }
  join(_channel: string): void {}
  tagmsg(_target: string, _tags?: unknown): void {}
  requestCap(_cap: string | string[]): void {}
  raw(_cmd: string, ..._args: string[]): void {}
}

/**
 * Inject an AccountRuntime directly into a provider without opening a socket,
 * then wire the event listeners. Returns handles for manipulation in tests.
 */
function injectRuntime(opts: {
  accountKey?: string;
  nick?: string;
  saslUser?: string;
  callbacks?: IrcProviderCallbacks;
  client?: MockClient;
}): {
  provider: IrcProvider;
  client: MockClient;
  rt: Record<string, unknown>;
} {
  const accountKey = opts.accountKey ?? "acc";
  const nick = opts.nick ?? "testbot";
  const client = opts.client ?? new MockClient();

  const config: IrcConfig = {
    enabled: true,
    accounts: {
      [accountKey]: {
        host: "irc.example.net",
        nick,
        ...(opts.saslUser ? { sasl_user: opts.saslUser, sasl_password: "pw" } : {}),
      },
    },
  };

  const provider = new IrcProvider(config, opts.callbacks);
  (provider as unknown as Record<string, unknown>).host = {
    onEvent() {},
    onError() {},
    onReaction() {},
  };
  (provider as unknown as Record<string, unknown>).stopped = false;

  const rt: Record<string, unknown> = {
    accountId: accountKey,
    config: config.accounts![accountKey],
    client,
    self: undefined,
    capFailed: false,
    registered: true, // already registered — we skip the registration dance
    capDelReconnect: false,
    casemapping: "ascii",
    networkName: "irc.example.net",
    nick,
    username: nick,
    host: "",
    hasLabeledResponse: false,
    hasMsgid: false,
    echoQueues: new Map(),
    pendingByLabel: new Map(),
    accountTracker: new AccountTracker(),
    rosterTracker: new RosterTracker(),
    channelData: new Map<string, { topic?: string; modes?: string }>(),
  };

  const accounts = (provider as unknown as Record<string, unknown>).accounts as Map<string, unknown>;
  accounts.set(accountKey, rt);
  (provider as unknown as { attachListeners(rt: unknown): void }).attachListeners(rt);

  return { provider, client, rt };
}

// ── D1. extended-join account tracking ──────────────────────────────────────

describe("IrcProvider: join (extended-join account tracking)", () => {
  test("extended-join with account string → tracker updated", async () => {
    const { client, rt } = injectRuntime({});
    const tracker = rt.accountTracker as AccountTracker;

    client.emit("join", {
      nick: "alice",
      ident: "alice",
      hostname: "alice.example.com",
      channel: "#chan",
      account: "alice_services",
      tags: {},
      time: Date.now(),
    });

    assert.equal(tracker.getAccount("alice", "ascii"), "alice_services");
  });

  test("extended-join with account=false → tracker entry cleared", async () => {
    const { client, rt } = injectRuntime({});
    const tracker = rt.accountTracker as AccountTracker;
    tracker.setAccount("bob", "old_acct", "ascii");

    client.emit("join", {
      nick: "bob",
      ident: "bob",
      hostname: "bob.example.com",
      channel: "#chan",
      account: false, // not identified at join time
      tags: {},
      time: Date.now(),
    });

    assert.equal(tracker.getAccount("bob", "ascii"), undefined);
  });

  test("extended-join with account=undefined → no tracker change (cap not enabled)", async () => {
    const { client, rt } = injectRuntime({});
    const tracker = rt.accountTracker as AccountTracker;
    tracker.setAccount("carol", "carolacct", "ascii");

    client.emit("join", {
      nick: "carol",
      ident: "carol",
      hostname: "carol.example.com",
      channel: "#chan",
      account: undefined, // extended-join not enabled
      tags: {},
      time: Date.now(),
    });

    // Tracker must be unchanged when cap not enabled
    assert.equal(tracker.getAccount("carol", "ascii"), "carolacct");
  });

  test("self-join triggers WHO for the channel (WHOX population)", async () => {
    const client = new MockClient();
    const { rt } = injectRuntime({ client, nick: "testbot" });

    client.emit("join", {
      nick: "testbot",
      ident: "testbot",
      hostname: "bot.example.com",
      channel: "#chan",
      account: undefined,
      tags: {},
      time: Date.now(),
    });

    assert.equal(client.whoCallCount, 1, "WHO must be issued on self-join");
  });

  test("self-join WHO callback populates accountTracker from WHOX", async () => {
    const client = new MockClient();
    const { rt } = injectRuntime({ client, nick: "testbot" });
    const tracker = rt.accountTracker as AccountTracker;

    // Emit self-join, which issues WHO.
    client.emit("join", {
      nick: "testbot",
      ident: "testbot",
      hostname: "bot.example.com",
      channel: "#chan",
      account: undefined,
      tags: {},
      time: Date.now(),
    });

    // Fire the WHO callback with WHOX-style results.
    client.whoCallback?.({
      target: "#chan",
      users: [
        { nick: "alice", account: "alice_services" },
        { nick: "bob", account: "" },       // not identified
        { nick: "carol", account: undefined }, // non-WHOX
      ],
    });

    assert.equal(tracker.getAccount("alice", "ascii"), "alice_services");
    assert.equal(tracker.getAccount("bob", "ascii"), undefined);
    assert.equal(tracker.getAccount("carol", "ascii"), undefined);
  });

  test("other user's join does NOT trigger WHO", async () => {
    const client = new MockClient();
    const { rt: _ } = injectRuntime({ client, nick: "testbot" });

    client.emit("join", {
      nick: "alice",
      ident: "alice",
      hostname: "alice.example.com",
      channel: "#chan",
      account: undefined,
      tags: {},
      time: Date.now(),
    });

    assert.equal(client.whoCallCount, 0);
  });
});

// ── D2. account-notify ────────────────────────────────────────────────────────

describe("IrcProvider: account (account-notify)", () => {
  test("ACCOUNT login (string) → tracker updated", () => {
    const { client, rt } = injectRuntime({});
    const tracker = rt.accountTracker as AccountTracker;

    client.emit("account", {
      nick: "alice",
      ident: "alice",
      hostname: "h",
      account: "alice_services",
      tags: {},
      time: Date.now(),
    });

    assert.equal(tracker.getAccount("alice", "ascii"), "alice_services");
  });

  test("ACCOUNT logout (false) → tracker entry cleared", () => {
    const { client, rt } = injectRuntime({});
    const tracker = rt.accountTracker as AccountTracker;
    tracker.setAccount("bob", "bobacct", "ascii");

    client.emit("account", {
      nick: "bob",
      ident: "bob",
      hostname: "h",
      account: false, // library maps "*" → false
      tags: {},
      time: Date.now(),
    });

    assert.equal(tracker.getAccount("bob", "ascii"), undefined);
  });
});

// ── D3. quit (prune) ──────────────────────────────────────────────────────────

describe("IrcProvider: quit (QUIT pruning)", () => {
  test("QUIT removes nick from accountTracker", () => {
    const { client, rt } = injectRuntime({});
    const tracker = rt.accountTracker as AccountTracker;
    tracker.setAccount("dave", "daveacct", "ascii");

    client.emit("quit", {
      nick: "dave",
      ident: "dave",
      hostname: "h",
      message: "Bye",
      tags: {},
      time: Date.now(),
    });

    assert.equal(tracker.getAccount("dave", "ascii"), undefined);
  });
});

// ── D4. nick (NICK rename tracking + alias callback) ──────────────────────────

describe("IrcProvider: nick (rename tracking §5.4)", () => {
  test("NICK rename moves tracker entry from old nick to new nick", () => {
    const { client, rt } = injectRuntime({});
    const tracker = rt.accountTracker as AccountTracker;
    tracker.setAccount("eve", "eveacct", "ascii");

    client.emit("nick", {
      nick: "eve",
      new_nick: "eve_",
      ident: "eve",
      hostname: "h",
      tags: {},
      time: Date.now(),
    });

    assert.equal(tracker.getAccount("eve_", "ascii"), "eveacct");
    assert.equal(tracker.getAccount("eve", "ascii"), undefined);
  });

  test("NICK rename invokes upsertUserIdentity callback with new nick as username", async () => {
    const captured: UserIdentityUpsertInput[] = [];
    const callbacks: IrcProviderCallbacks = {
      async upsertUserIdentity(input) { captured.push({ ...input }); },
    };
    const { client, rt } = injectRuntime({ callbacks });
    const tracker = rt.accountTracker as AccountTracker;
    // Give alice a known account so identityKey = account name
    tracker.setAccount("alice", "alice_acct", "ascii");

    client.emit("nick", {
      nick: "alice",
      new_nick: "alice_away",
      ident: "alice",
      hostname: "h",
      tags: {},
      time: 1_700_000_000_000,
    });

    // Wait for the fire-and-forget void promise
    await new Promise((r) => setImmediate(r));

    assert.equal(captured.length, 1, "upsertUserIdentity must be called");
    const call = captured[0]!;
    assert.equal(call.provider, "irc");
    assert.equal(call.userId, "alice_acct", "userId must be the stable account name");
    assert.equal(call.username, "alice_away", "username must be the new nick");
    assert.equal(call.observedAt, 1_700_000_000_000);
  });

  test("NICK rename without tracked account: identity key = old casemapped nick", async () => {
    const captured: UserIdentityUpsertInput[] = [];
    const callbacks: IrcProviderCallbacks = {
      async upsertUserIdentity(input) { captured.push({ ...input }); },
    };
    const { client } = injectRuntime({ callbacks });

    client.emit("nick", {
      nick: "frank",
      new_nick: "frank_",
      ident: "frank",
      hostname: "h",
      tags: {},
      time: 1_700_000_000_000,
    });

    await new Promise((r) => setImmediate(r));

    assert.equal(captured.length, 1);
    const call = captured[0]!;
    assert.equal(call.userId, "frank", "userId must be casemapped old nick when no account known");
    assert.equal(call.username, "frank_");
  });

  test("own NICK change: rt.nick updated, self-identity keeps SASL account", () => {
    const { client, rt } = injectRuntime({ nick: "testbot", saslUser: "botaccount" });
    rt.nick = "testbot";
    (rt as unknown as Record<string, unknown>).self = { id: "botaccount", username: "testbot" };

    client.emit("nick", {
      nick: "testbot",
      new_nick: "Guest12345",
      ident: "testbot",
      hostname: "h",
      tags: {},
      time: Date.now(),
    });

    assert.equal(rt.nick, "Guest12345", "rt.nick must be updated to new nick");
    const self = rt.self as { id: string; username: string } | undefined;
    assert.equal(self?.id, "botaccount", "self.id must remain the SASL account (stable)");
    assert.equal(self?.username, "Guest12345", "self.username must be updated to new nick");
  });

  test("own NICK change without SASL: self-identity switches to new casemapped nick", () => {
    const { client, rt } = injectRuntime({ nick: "testbot" });
    rt.nick = "testbot";

    client.emit("nick", {
      nick: "testbot",
      new_nick: "Guest12345",
      ident: "testbot",
      hostname: "h",
      tags: {},
      time: Date.now(),
    });

    assert.equal(rt.nick, "Guest12345");
    const self = rt.self as { id: string; username: string } | undefined;
    assert.equal(self?.id, "guest12345", "self.id must be casemapped new nick when no SASL");
    assert.equal(self?.username, "Guest12345");
  });
});

// ── D5. upsertUserIdentity: NOT called for own NICK (self) ───────────────────

describe("IrcProvider: upsertUserIdentity not called for self NICK", () => {
  test("own NICK does not invoke upsertUserIdentity callback", async () => {
    const captured: UserIdentityUpsertInput[] = [];
    const callbacks: IrcProviderCallbacks = {
      async upsertUserIdentity(input) { captured.push({ ...input }); },
    };
    const { client } = injectRuntime({ callbacks, nick: "testbot" });

    client.emit("nick", {
      nick: "testbot",
      new_nick: "testbot_",
      ident: "testbot",
      hostname: "h",
      tags: {},
      time: Date.now(),
    });

    await new Promise((r) => setImmediate(r));

    assert.equal(captured.length, 0, "upsertUserIdentity must NOT fire for own NICK");
  });
});

// ── D6. notice: account-tag opportunistic refresh ─────────────────────────────

describe("IrcProvider: notice handler account-tag refresh (F2)", () => {
  /**
   * Build a provider+runtime with a capturing host, independent of the shared
   * injectRuntime helper (which uses a no-op host). Needed here to assert that
   * a post-NOTICE PRIVMSG produces an event with the correct sender.id.
   */
  function injectWithCapturingHost(): {
    client: MockClient;
    rt: Record<string, unknown>;
    events: unknown[];
  } {
    const events: unknown[] = [];
    const client = new MockClient();
    const accountKey = "acc";
    const nick = "testbot";
    const config: IrcConfig = {
      enabled: true,
      accounts: { [accountKey]: { host: "irc.example.net", nick } },
    };
    const provider = new IrcProvider(config);
    (provider as unknown as Record<string, unknown>).host = {
      onEvent(e: unknown) { events.push(e); },
      onError() {},
      onReaction() {},
    };
    (provider as unknown as Record<string, unknown>).stopped = false;
    const rt: Record<string, unknown> = {
      accountId: accountKey,
      config: config.accounts![accountKey],
      client,
      self: undefined,
      capFailed: false,
      registered: true,
      capDelReconnect: false,
      casemapping: "ascii",
      networkName: "irc.example.net",
      nick,
      username: nick,
      host: "",
      hasLabeledResponse: false,
      hasMsgid: false,
      echoQueues: new Map(),
      pendingByLabel: new Map(),
      accountTracker: new AccountTracker(),
    };
    (provider as unknown as Record<string, unknown>).accounts = new Map([[accountKey, rt]]);
    (provider as unknown as { attachListeners(rt: unknown): void }).attachListeners(rt);
    return { client, rt, events };
  }

  test("NOTICE with account-tag seeds tracker", () => {
    const { client, rt } = injectWithCapturingHost();
    const tracker = rt.accountTracker as AccountTracker;

    client.emit("notice", {
      from_server: false,
      nick: "alice",
      ident: "alice",
      hostname: "h",
      target: "#chan",
      message: "heads up",
      tags: { msgid: "n1" },
      time: Date.now(),
      account: "alice_services",
    });

    assert.equal(
      tracker.getAccount("alice", "ascii"),
      "alice_services",
      "NOTICE with account-tag must seed the tracker",
    );
  });

  test("PRIVMSG following a NOTICE with account-tag resolves sender.id via tracker", () => {
    const { client, events } = injectWithCapturingHost();

    // NOTICE seeds the tracker with alice's account name.
    client.emit("notice", {
      from_server: false,
      nick: "alice",
      ident: "alice",
      hostname: "h",
      target: "#chan",
      message: "heads up",
      tags: { msgid: "n1" },
      time: Date.now(),
      account: "alice_services",
    });

    // PRIVMSG arrives without account-tag; tracker must supply the identity.
    client.emit("privmsg", {
      from_server: false,
      nick: "alice",
      ident: "alice",
      hostname: "h",
      target: "#chan",
      message: "hi",
      tags: { msgid: "p1" },
      time: Date.now(),
      account: undefined,
    });

    // Channel NOTICEs are also ingested (spec §7.5), so onEvent fires twice:
    // index 0 = NOTICE inbound, index 1 = PRIVMSG inbound.
    assert.equal(events.length, 2, "NOTICE and PRIVMSG must each produce an inbound event");
    const ev = events[1] as { event: { sender: { id: string } } };
    assert.equal(
      ev.event.sender.id,
      "alice_services",
      "sender.id must resolve to account via tracker seeded by prior NOTICE",
    );
  });
});
