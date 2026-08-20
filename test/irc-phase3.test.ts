/**
 * Phase 3 IRC tests — tool surface + touch points (spec IRC-SUPPORT-DESIGN §7.6, §10).
 *
 * Coverage groups:
 *   A. IRC_TERMINOLOGY shape and distinctness from MATRIX/DISCORD constants
 *   B. buildMirrorTopology: IRC accounts included in mirror topology
 *   C. RosterTracker unit tests (join/part/quit/nick/away/back)
 *   D. IrcProvider: channelInfo topic tracking via TOPIC event
 *   E. IrcProvider: memberInfo WHOIS mapping (mocked client)
 *   F. IrcProvider: members() shape matches tool-layer expectations (id ladder)
 *   G. IrcProvider: setChannelMetadata callback invoked on inbound channel message
 */

import assert from "node:assert/strict";
import test, { describe, mock } from "node:test";
import { EventEmitter } from "node:events";

import { MATRIX_TERMINOLOGY, DISCORD_TERMINOLOGY, IRC_TERMINOLOGY } from "../src/tools/terminology.js";
import { buildMirrorTopology } from "../src/summarization/mirror-worker.js";
import { RosterTracker } from "../src/irc/roster-tracker.js";
import { IrcProvider, type IrcProviderCallbacks } from "../src/irc/provider.js";
import { AccountTracker } from "../src/irc/account-tracker.js";
import type { AppConfig } from "../src/config/index.js";

// ── A. IRC_TERMINOLOGY ────────────────────────────────────────────────────────

describe("IRC_TERMINOLOGY", () => {
  test("providerName is 'IRC'", () => {
    assert.equal(IRC_TERMINOLOGY.providerName, "IRC");
  });

  test("channelNoun is 'channel'", () => {
    assert.equal(IRC_TERMINOLOGY.channelNoun, "channel");
  });

  test("userIdFmt mentions nick and services account", () => {
    assert.match(IRC_TERMINOLOGY.userIdFmt, /nick/i);
    assert.match(IRC_TERMINOLOGY.userIdFmt, /account/i);
  });

  test("mentionNote explains bare-nick mention semantics", () => {
    assert.ok(IRC_TERMINOLOGY.mentionNote.length > 0, "mentionNote must be non-empty");
    assert.match(IRC_TERMINOLOGY.mentionNote, /nick/i);
  });

  test("is a distinct object from MATRIX_TERMINOLOGY", () => {
    assert.notEqual(IRC_TERMINOLOGY, MATRIX_TERMINOLOGY);
    assert.notEqual(IRC_TERMINOLOGY.providerName, MATRIX_TERMINOLOGY.providerName);
  });

  test("is a distinct object from DISCORD_TERMINOLOGY", () => {
    assert.notEqual(IRC_TERMINOLOGY, DISCORD_TERMINOLOGY);
    assert.notEqual(IRC_TERMINOLOGY.providerName, DISCORD_TERMINOLOGY.providerName);
  });

  test("MATRIX_TERMINOLOGY is unchanged (byte-identical behavior preserved)", () => {
    assert.equal(MATRIX_TERMINOLOGY.providerName, "Matrix");
    assert.equal(MATRIX_TERMINOLOGY.channelNoun, "room");
  });

  test("DISCORD_TERMINOLOGY is unchanged (byte-identical behavior preserved)", () => {
    assert.equal(DISCORD_TERMINOLOGY.providerName, "Discord");
    assert.equal(DISCORD_TERMINOLOGY.channelNoun, "channel");
  });
});

// ── B. buildMirrorTopology: IRC accounts included ─────────────────────────────

describe("buildMirrorTopology: IRC accounts", () => {
  test("IRC account included with provider='irc' in topology", () => {
    const config = {
      agents: {
        miku: { summaries_from: "miku-donor" },
      },
      matrix: { accounts: {} },
      discord: { accounts: {} },
      irc: {
        enabled: true,
        accounts: {
          "irc-main": { host: "irc.example.net", nick: "miku", agent: "miku" },
        },
      },
    } as unknown as AppConfig;

    const topology = buildMirrorTopology(config);
    assert.equal(topology.length, 1);
    const entry = topology[0]!;
    // miku is a secondary that receives summaries from miku-donor
    const secondaryAccts = entry.secondaryAccountsByProvider.get("irc");
    assert.ok(secondaryAccts, "secondary accounts must include irc provider");
    assert.ok(secondaryAccts.includes("irc-main"), "irc-main must appear in secondary accounts");
  });

  test("IRC account with implicit agent name (key == agent name) is still picked up", () => {
    const config = {
      agents: {
        "irc-bot": { summaries_from: "main-bot" },
      },
      matrix: { accounts: {} },
      discord: { accounts: {} },
      irc: {
        enabled: true,
        accounts: {
          // No explicit `agent` field → key "irc-bot" is the agent name
          "irc-bot": { host: "irc.example.net", nick: "bot" },
        },
      },
    } as unknown as AppConfig;

    const topology = buildMirrorTopology(config);
    assert.equal(topology.length, 1);
    const secondaryAccts = topology[0]!.secondaryAccountsByProvider.get("irc");
    assert.ok(secondaryAccts, "irc provider must be present in secondary accounts");
    assert.ok(secondaryAccts.includes("irc-bot"), "irc-bot key must appear in secondary accounts");
  });

  test("IRC accounts not present in config → not in topology", () => {
    const config = {
      agents: {
        miku: { summaries_from: "donor" },
      },
      matrix: { accounts: {} },
      discord: { accounts: {} },
      // No irc block
    } as unknown as AppConfig;

    const topology = buildMirrorTopology(config);
    for (const entry of topology) {
      assert.ok(
        !entry.secondaryAccountsByProvider.has("irc"),
        "irc must not appear when no irc config",
      );
      assert.ok(
        !entry.donorAccountByProvider.has("irc"),
        "irc must not appear as donor when no irc config",
      );
    }
  });
});

// ── C. RosterTracker unit tests ───────────────────────────────────────────────

describe("RosterTracker", () => {
  test("addMember / getMembers: basic round-trip", () => {
    const tracker = new RosterTracker();
    tracker.addMember("#general", "alice", "ascii");
    const members = tracker.getMembers("#general", "ascii");
    assert.equal(members.length, 1);
    assert.equal(members[0]!.nick, "alice");
    assert.deepEqual(members[0]!.modes, []);
    assert.equal(members[0]!.away, false);
  });

  test("addMember: casemapping applied to channel key", () => {
    const tracker = new RosterTracker();
    tracker.addMember("#General", "alice", "ascii");
    // Lookup with lowercase should still find it (casemapped key).
    assert.equal(tracker.getMemberCount("#general", "ascii"), 1);
  });

  test("initChannel: reinitialises roster from NAMES list", () => {
    const tracker = new RosterTracker();
    tracker.addMember("#general", "stale-user", "ascii");
    tracker.initChannel("#general", [
      { nick: "alice", modes: ["o"] },
      { nick: "bob", modes: [] },
    ], "ascii");
    const members = tracker.getMembers("#general", "ascii");
    const nicks = members.map((m) => m.nick).sort();
    assert.deepEqual(nicks, ["alice", "bob"], "stale-user must be replaced");
    assert.deepEqual(
      members.find((m) => m.nick === "alice")!.modes,
      ["o"],
      "mode preserved from NAMES",
    );
  });

  test("removeMember: removes user from specific channel on PART", () => {
    const tracker = new RosterTracker();
    tracker.addMember("#general", "alice", "ascii");
    tracker.addMember("#other", "alice", "ascii");
    tracker.removeMember("#general", "alice", "ascii");
    assert.equal(tracker.getMemberCount("#general", "ascii"), 0, "removed from #general");
    assert.equal(tracker.getMemberCount("#other", "ascii"), 1, "still in #other");
  });

  test("removeNick: removes user from all channels on QUIT", () => {
    const tracker = new RosterTracker();
    tracker.addMember("#general", "alice", "ascii");
    tracker.addMember("#other", "alice", "ascii");
    tracker.removeNick("alice", "ascii");
    assert.equal(tracker.getMemberCount("#general", "ascii"), 0, "removed from #general");
    assert.equal(tracker.getMemberCount("#other", "ascii"), 0, "removed from #other");
  });

  test("renameNick: updates nick in all channels, preserves modes and away", () => {
    const tracker = new RosterTracker();
    tracker.initChannel("#general", [{ nick: "alice", modes: ["o"] }], "ascii");
    tracker.initChannel("#other", [{ nick: "alice", modes: ["v"] }], "ascii");
    tracker.setAway("alice", "ascii");
    tracker.renameNick("alice", "alice_", "ascii");

    const inGeneral = tracker.getMember("#general", "alice_", "ascii");
    assert.ok(inGeneral, "alice_ must appear in #general after rename");
    assert.equal(inGeneral.nick, "alice_", "nick updated");
    assert.deepEqual(inGeneral.modes, ["o"], "modes preserved");
    assert.equal(inGeneral.away, true, "away state preserved");

    // Old key gone
    assert.equal(tracker.getMember("#general", "alice", "ascii"), undefined);

    const inOther = tracker.getMember("#other", "alice_", "ascii");
    assert.ok(inOther, "alice_ must appear in #other too");
    assert.deepEqual(inOther.modes, ["v"], "modes preserved in #other");
  });

  test("setAway: marks user away in all channels", () => {
    const tracker = new RosterTracker();
    tracker.addMember("#general", "alice", "ascii");
    tracker.addMember("#other", "alice", "ascii");
    tracker.setAway("alice", "ascii");
    assert.equal(tracker.getMember("#general", "alice", "ascii")!.away, true);
    assert.equal(tracker.getMember("#other", "alice", "ascii")!.away, true);
  });

  test("setBack: marks user not-away (back) in all channels", () => {
    const tracker = new RosterTracker();
    tracker.addMember("#general", "alice", "ascii");
    tracker.setAway("alice", "ascii");
    assert.equal(tracker.getMember("#general", "alice", "ascii")!.away, true);
    tracker.setBack("alice", "ascii");
    assert.equal(tracker.getMember("#general", "alice", "ascii")!.away, false);
  });

  test("clear: removes all channel tracking state", () => {
    const tracker = new RosterTracker();
    tracker.addMember("#general", "alice", "ascii");
    tracker.clear();
    assert.equal(tracker.getMemberCount("#general", "ascii"), 0);
  });

  test("findNickByAccount: returns nick whose account matches", () => {
    const tracker = new RosterTracker();
    tracker.initChannel("#general", [
      { nick: "alice", modes: [] },
      { nick: "bob", modes: [] },
    ], "ascii");
    const accounts = new Map([["alice", "alice_acct"]]);
    const result = tracker.findNickByAccount(
      "#general",
      "alice_acct",
      (n) => accounts.get(n),
      "ascii",
    );
    assert.equal(result, "alice", "must return the nick whose account matches");
  });

  test("findNickByAccount: returns undefined when no match", () => {
    const tracker = new RosterTracker();
    tracker.initChannel("#general", [{ nick: "alice", modes: [] }], "ascii");
    const result = tracker.findNickByAccount("#general", "nobody_acct", () => undefined, "ascii");
    assert.equal(result, undefined);
  });
});

// ── Shared MockClient for IrcProvider tests ───────────────────────────────────

class MockClient extends EventEmitter {
  network: {
    cap: { enabled: string[] };
    supports(name: string): string | boolean | undefined;
  } = {
    cap: { enabled: ["server-time", "message-tags", "echo-message"] },
    supports(_name: string) { return undefined; },
  };

  connected = false;
  connectCallCount = 0;

  connect(): void { this.connectCallCount++; }
  quit(_msg?: string): void {}
  say(_target: string, _body: string, _tags?: Record<string, string>): void {}
  who(_target: string, _cb?: (e: { users: Array<unknown> }) => void): void {}
  whois(nick: string, cb: (event: Record<string, unknown>) => void): void {
    // Default: no-op (tests override via reassignment).
    void nick;
    void cb;
  }
  join(_channel: string): void {}
  tagmsg(_target: string, _tags?: Record<string, string>): void {}
  requestCap(_cap: string | string[]): void {}
  raw(_cmd: string, ..._args: string[]): void {}
}

/**
 * Inject a minimal AccountRuntime into a provider without opening a socket,
 * then wire event listeners. Matches the runtime shape expected by Phase 3 code.
 */
function injectRuntime(opts: {
  accountKey?: string;
  nick?: string;
  networkName?: string;
  callbacks?: IrcProviderCallbacks;
  client?: MockClient;
}): {
  provider: IrcProvider;
  client: MockClient;
  rt: Record<string, unknown>;
} {
  const accountKey = opts.accountKey ?? "acc";
  const nick = opts.nick ?? "testbot";
  const networkName = opts.networkName ?? "irc.example.net";
  const client = opts.client ?? new MockClient();

  const provider = new IrcProvider(
    {
      enabled: true,
      accounts: {
        [accountKey]: { host: networkName, nick },
      },
    },
    opts.callbacks,
  );

  (provider as unknown as Record<string, unknown>).host = {
    onEvent() {},
    onError() {},
    onReaction() {},
  };
  (provider as unknown as Record<string, unknown>).stopped = false;

  const rt: Record<string, unknown> = {
    accountId: accountKey,
    config: { host: networkName, nick, channels: [] },
    client,
    self: { id: `${networkName}/${nick}`, username: nick },
    capFailed: false,
    registered: true,
    capDelReconnect: false,
    casemapping: "ascii",
    networkName,
    networkIdFrozen: true, // freeze so inbound handlers (privmsg/notice/action) pass the gate
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

// ── D. channelInfo topic tracking ─────────────────────────────────────────────

describe("IrcProvider channelInfo: topic tracking", () => {
  test("topic event updates channelInfo topic", async () => {
    const { provider, client } = injectRuntime({});

    client.emit("topic", {
      channel: "#general",
      topic: "Welcome to #general!",
      tags: {},
    });

    const ch = provider.channelClient({ provider: "irc", timelineKey: "irc:acc:room:#general" });
    assert.ok(ch, "channelClient must return a client for a known account");
    const info = await ch.channelInfo();
    assert.equal(info.topic, "Welcome to #general!", "topic must reflect the TOPIC event");
  });

  test("topic event with empty string clears topic", async () => {
    const { provider, client } = injectRuntime({});

    // Set a topic first.
    client.emit("topic", { channel: "#general", topic: "Initial topic", tags: {} });
    // Clear it (RPL_NOTOPIC sends empty string).
    client.emit("topic", { channel: "#general", topic: "", tags: {} });

    const ch = provider.channelClient({ provider: "irc", timelineKey: "irc:acc:room:#general" });
    assert.ok(ch);
    const info = await ch.channelInfo();
    assert.equal(info.topic, undefined, "empty topic string must be stored as undefined");
  });

  test("channelInfo returns serverName matching networkName", async () => {
    const { provider } = injectRuntime({ networkName: "liberachat" });

    const ch = provider.channelClient({ provider: "irc", timelineKey: "irc:acc:room:#general" });
    assert.ok(ch);
    const info = await ch.channelInfo();
    assert.equal(info.serverName, "liberachat", "serverName must be the network name");
  });

  test("channelInfo isDirect=false for channel targets", async () => {
    const { provider } = injectRuntime({});
    const ch = provider.channelClient({ provider: "irc", timelineKey: "irc:acc:room:#general" });
    assert.ok(ch);
    const info = await ch.channelInfo();
    assert.equal(info.isDirect, false);
  });

  test("channelInfo memberCount reflects roster size after userlist", async () => {
    const { provider, client } = injectRuntime({});

    client.emit("userlist", {
      channel: "#general",
      users: [
        { nick: "alice", ident: "alice", hostname: "h", modes: [], tags: {} },
        { nick: "bob", ident: "bob", hostname: "h", modes: [], tags: {} },
      ],
      tags: {},
    });

    const ch = provider.channelClient({ provider: "irc", timelineKey: "irc:acc:room:#general" });
    assert.ok(ch);
    const info = await ch.channelInfo();
    assert.equal(info.memberCount, 2, "memberCount must match roster after NAMES");
  });
});

// ── E. memberInfo WHOIS mapping ───────────────────────────────────────────────

describe("IrcProvider memberInfo: WHOIS mapping", () => {
  test("memberInfo returns network-scoped userId=account when WHOIS provides account", async () => {
    const client = new MockClient();
    const { provider } = injectRuntime({ client });

    // Mock whois: call callback immediately with a result.
    client.whois = (nick: string, cb: (event: Record<string, unknown>) => void) => {
      cb({ nick, ident: "alice", hostname: "example.com", account: "alice_services" });
    };

    const ch = provider.channelClient({ provider: "irc", timelineKey: "irc:acc:room:#general" });
    assert.ok(ch);
    // memberInfo accepts a network-scoped id; it strips the prefix before WHOIS.
    const info = await ch.memberInfo("irc.example.net/alice");
    assert.ok(info, "memberInfo must return a result");
    assert.equal(info.userId, "irc.example.net/alice_services", "userId must be the network-scoped services account from WHOIS");
    assert.equal(info.displayName, "alice", "displayName must be the nick");
    assert.equal(info.isDirect, false);
  });

  test("memberInfo falls back to network-scoped casemapped nick when WHOIS has no account", async () => {
    const client = new MockClient();
    const { provider } = injectRuntime({ client });

    client.whois = (nick: string, cb: (event: Record<string, unknown>) => void) => {
      cb({ nick, ident: "bob", hostname: "example.com" }); // no account field
    };

    const ch = provider.channelClient({ provider: "irc", timelineKey: "irc:acc:room:#general" });
    assert.ok(ch);
    const info = await ch.memberInfo("irc.example.net/bob");
    assert.ok(info, "memberInfo must return a result");
    // No account → id is network-scoped casemapped nick
    assert.equal(info.userId, "irc.example.net/bob", "userId must be network-scoped casemapped nick when no account");
  });

  test("memberInfo resolves undefined when WHOIS never replies (timeout)", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const client = new MockClient();
      const { provider } = injectRuntime({ client });

      // WHOIS reply never arrives (connection dropped mid-query).
      client.whois = () => {};

      const ch = provider.channelClient({ provider: "irc", timelineKey: "irc:acc:room:#general" });
      assert.ok(ch);
      const infoPromise = ch.memberInfo("irc.example.net/ghost");

      // Advance past WHOIS_TIMEOUT_MS (10 000 ms).
      mock.timers.tick(10_001);

      const info = await infoPromise;
      assert.equal(info, undefined, "unanswered WHOIS must resolve undefined, not hang");
    } finally {
      mock.timers.reset();
    }
  });

  test("memberInfo returns undefined when WHOIS says not_found", async () => {
    const client = new MockClient();
    const { provider } = injectRuntime({ client });

    client.whois = (_nick: string, cb: (event: Record<string, unknown>) => void) => {
      cb({ error: "not_found" });
    };

    const ch = provider.channelClient({ provider: "irc", timelineKey: "irc:acc:room:#general" });
    assert.ok(ch);
    const info = await ch.memberInfo("irc.example.net/nobody");
    assert.equal(info, undefined, "not_found WHOIS must return undefined");
  });

  test("memberInfo resolves account name via roster before issuing WHOIS", async () => {
    const client = new MockClient();
    const { provider, rt } = injectRuntime({ client });

    // Seed roster and account tracker.
    (rt.rosterTracker as RosterTracker).addMember("#general", "alice", "ascii");
    (rt.accountTracker as AccountTracker).setAccount("alice", "alice_services", "ascii");

    const whoisCalls: string[] = [];
    client.whois = (nick: string, cb: (event: Record<string, unknown>) => void) => {
      whoisCalls.push(nick);
      cb({ nick, ident: "alice", hostname: "h", account: "alice_services" });
    };

    const ch = provider.channelClient({ provider: "irc", timelineKey: "irc:acc:room:#general" });
    assert.ok(ch);
    // Look up by scoped account name (network-prefix + account).
    const info = await ch.memberInfo("irc.example.net/alice_services");
    assert.ok(info);
    // WHOIS was issued for the nick (resolved from account→nick lookup).
    assert.deepEqual(whoisCalls, ["alice"], "WHOIS must be issued for the nick, not the account name");
    assert.equal(info.userId, "irc.example.net/alice_services");
  });
});

// ── F. members() shape ────────────────────────────────────────────────────────

describe("IrcProvider members(): shape matches tool-layer expectations", () => {
  test("members() returns empty array before NAMES", async () => {
    const { provider } = injectRuntime({});
    const ch = provider.channelClient({ provider: "irc", timelineKey: "irc:acc:room:#general" });
    assert.ok(ch);
    const members = await ch.members();
    assert.deepEqual(members, [], "no members before NAMES reply");
  });

  test("members() returns roster with correct id/username after NAMES", async () => {
    const { provider, client } = injectRuntime({});

    client.emit("userlist", {
      channel: "#general",
      users: [
        { nick: "alice", ident: "alice", hostname: "h", modes: [], tags: {} },
        { nick: "bob", ident: "bob", hostname: "h", modes: ["o"], tags: {} },
      ],
      tags: {},
    });

    const ch = provider.channelClient({ provider: "irc", timelineKey: "irc:acc:room:#general" });
    assert.ok(ch);
    const members = await ch.members();
    assert.equal(members.length, 2, "must return 2 members");

    // Each member must have id and username; no duplicate ids.
    for (const m of members) {
      assert.ok(typeof m.id === "string" && m.id.length > 0, "id must be non-empty string");
      assert.ok(typeof m.username === "string" && m.username.length > 0, "username must be non-empty string");
    }
  });

  test("members() id = account when account known (identity ladder)", async () => {
    const { provider, client, rt } = injectRuntime({});

    client.emit("userlist", {
      channel: "#general",
      users: [{ nick: "alice", ident: "alice", hostname: "h", modes: [], tags: {} }],
      tags: {},
    });

    // Seed account tracker (as extended-join or account-notify would do).
    (rt.accountTracker as AccountTracker).setAccount("alice", "alice_services", "ascii");

    const ch = provider.channelClient({ provider: "irc", timelineKey: "irc:acc:room:#general" });
    assert.ok(ch);
    const members = await ch.members();
    const alice = members.find((m) => m.username === "alice");
    assert.ok(alice, "alice must appear in members");
    // Identity ladder: account known → id = network-scoped account name.
    assert.equal(alice.id, "irc.example.net/alice_services", "id must be the network-scoped services account name");
    // Username is always the current nick.
    assert.equal(alice.username, "alice", "username is the IRC nick (used as deriveProviderUsername hint)");
  });

  test("members() id = casemapped nick when no account known", async () => {
    const { provider, client } = injectRuntime({});

    client.emit("userlist", {
      channel: "#general",
      users: [{ nick: "Bob", ident: "bob", hostname: "h", modes: [], tags: {} }],
      tags: {},
    });
    // No account tracker seeding.

    const ch = provider.channelClient({ provider: "irc", timelineKey: "irc:acc:room:#general" });
    assert.ok(ch);
    const members = await ch.members();
    const bob = members.find((m) => m.username === "Bob");
    assert.ok(bob, "Bob must appear");
    // No account → id is network-scoped casemapped nick (ascii casemapping: lowercase).
    assert.equal(bob.id, "irc.example.net/bob", "id must be network-scoped casemapped nick when no account");
  });

  test("members() returns empty array for DM targets", async () => {
    const { provider } = injectRuntime({});
    const ch = provider.channelClient({ provider: "irc", timelineKey: "irc:acc:dm:alice" });
    assert.ok(ch);
    const members = await ch.members();
    assert.deepEqual(members, [], "DM targets must return no members");
  });
});

// ── G. setChannelMetadata callback on inbound channel message ─────────────────

describe("IrcProvider: setChannelMetadata callback on inbound", () => {
  test("privmsg to channel triggers setChannelMetadata with network name as serverId", async () => {
    const metaCalls: Array<[string, Record<string, unknown>]> = [];
    const callbacks: IrcProviderCallbacks = {
      async upsertUserIdentity() {},
      async setChannelMetadata(timelineKey, meta) {
        metaCalls.push([timelineKey, meta as Record<string, unknown>]);
      },
    };
    const { client } = injectRuntime({ callbacks, networkName: "liberachat" });

    client.emit("privmsg", {
      from_server: false,
      nick: "alice",
      ident: "alice",
      hostname: "alice.example.com",
      target: "#general",
      message: "hello",
      tags: {},
      time: Date.now(),
    });

    // Allow any microtask-queued promises to settle.
    await Promise.resolve();

    assert.equal(metaCalls.length, 1, "setChannelMetadata must be called once");
    const [key, meta] = metaCalls[0]!;
    assert.match(key, /#general/, "timelineKey must include the channel name");
    assert.equal(meta["serverId"], "liberachat", "serverId must be the network name");
    assert.equal(meta["serverName"], "liberachat", "serverName must also be the network name");
  });

  test("privmsg DM does NOT trigger setChannelMetadata", async () => {
    const metaCalls: Array<unknown[]> = [];
    const callbacks: IrcProviderCallbacks = {
      async upsertUserIdentity() {},
      async setChannelMetadata(...args) {
        metaCalls.push(args);
      },
    };
    const { client } = injectRuntime({ callbacks });

    client.emit("privmsg", {
      from_server: false,
      nick: "alice",
      ident: "alice",
      hostname: "alice.example.com",
      target: "testbot", // DM target (not a channel)
      message: "hello",
      tags: {},
      time: Date.now(),
    });

    await Promise.resolve();

    assert.equal(metaCalls.length, 0, "setChannelMetadata must NOT be called for DMs");
  });

  test("notice to channel triggers setChannelMetadata", async () => {
    const metaCalls: Array<[string, Record<string, unknown>]> = [];
    const callbacks: IrcProviderCallbacks = {
      async upsertUserIdentity() {},
      async setChannelMetadata(timelineKey, meta) {
        metaCalls.push([timelineKey, meta as Record<string, unknown>]);
      },
    };
    const { client } = injectRuntime({ callbacks, networkName: "freenode" });

    client.emit("notice", {
      from_server: false,
      nick: "services",
      ident: "services",
      hostname: "services.freenode.net",
      target: "#general",
      message: "Channel notice",
      tags: {},
      time: Date.now(),
    });

    await Promise.resolve();

    assert.equal(metaCalls.length, 1, "setChannelMetadata must be called for channel notices");
    assert.equal(metaCalls[0]![1]["serverId"], "freenode");
  });

  test("action to channel triggers setChannelMetadata", async () => {
    const metaCalls: Array<[string, Record<string, unknown>]> = [];
    const callbacks: IrcProviderCallbacks = {
      async upsertUserIdentity() {},
      async setChannelMetadata(timelineKey, meta) {
        metaCalls.push([timelineKey, meta as Record<string, unknown>]);
      },
    };
    const { client } = injectRuntime({ callbacks, networkName: "undernet" });

    client.emit("action", {
      from_server: false,
      nick: "alice",
      ident: "alice",
      hostname: "alice.example.com",
      target: "#general",
      message: "does something",
      tags: {},
      time: Date.now(),
    });

    await Promise.resolve();

    assert.equal(metaCalls.length, 1, "setChannelMetadata must be called for channel actions");
    assert.equal(metaCalls[0]![1]["serverId"], "undernet");
  });
});
