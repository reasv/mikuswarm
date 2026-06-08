import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { TriggerCoordinator } from "../src/timeline/index.js";
import { SessionRunner } from "../src/agent/index.js";
import { configureAgentTimezone, resetAgentTimezone } from "../src/time/index.js";
import {
  ProactiveScheduler,
  resolveChannelConfig,
  evaluateGate,
  computeNextAttempt,
  resolveSchedulingWindow,
  proactiveGateScanLimit,
} from "../src/proactive/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { CanonicalChatEvent, InboundChatEvent } from "../src/types.js";

const TK = "matrix:miku:room:!room:server";

// ── resolveChannelConfig: override ?? global ?? default ──────────────

test("resolveChannelConfig: channel override beats global beats hardcoded default", () => {
  const eff = resolveChannelConfig(
    { daily_posts: 5, min_user_messages: 7, min_gap_ms: 99 },
    { timeline_key: TK, daily_posts: 9 },
  );
  assert.equal(eff.dailyPosts, 9, "channel override wins");
  assert.equal(eff.minUserMessages, 7, "global used when no channel override");
  assert.equal(eff.minGapMs, 99, "global used when no channel override");
  assert.equal(eff.deadChannelBackstopMs, 21_600_000, "hardcoded default when neither set");
});

// ── evaluateGate ────────────────────────────────────────────────────

function ev(id: string, ts: number, role: "user" | "assistant"): CanonicalChatEvent {
  return {
    id,
    timelineKey: TK,
    provider: "matrix",
    role,
    sender: { id: role === "assistant" ? "@miku:server" : "@u:server", isSelf: role === "assistant" },
    body: id,
    timestamp: ts,
    receivedAt: ts,
  };
}

const GATE = { deadChannelBackstopMs: 6 * 3_600_000, minUserMessages: 3 };

test("evaluateGate: empty timeline is skip_dead", () => {
  const r = evaluateGate([], 1000, GATE);
  assert.deepEqual(r, { ok: false, reason: "skip_dead" });
});

test("evaluateGate: newest older than backstop is skip_dead", () => {
  const now = 100 * 3_600_000;
  const events = [ev("a", now - 7 * 3_600_000, "user")];
  assert.deepEqual(evaluateGate(events, now, GATE), { ok: false, reason: "skip_dead" });
});

test("evaluateGate: fewer than min human messages since last assistant is skip_sparse", () => {
  const now = 10_000;
  const events = [
    ev("u1", 1000, "user"),
    ev("a1", 2000, "assistant"), // bot spoke here
    ev("u2", 3000, "user"),
    ev("u3", 4000, "user"), // only 2 human messages after the assistant
  ];
  assert.deepEqual(evaluateGate(events, now, GATE), { ok: false, reason: "skip_sparse" });
});

test("evaluateGate: enough human messages since last assistant passes", () => {
  const now = 10_000;
  const events = [
    ev("a1", 2000, "assistant"),
    ev("u1", 3000, "user"),
    ev("u2", 4000, "user"),
    ev("u3", 5000, "user"), // 3 human messages after the assistant == threshold
  ];
  assert.deepEqual(evaluateGate(events, now, GATE), { ok: true });
});

test("evaluateGate: no assistant in window — whole-window human count decides", () => {
  const now = 10_000;
  const events = [ev("u1", 3000, "user"), ev("u2", 4000, "user"), ev("u3", 5000, "user")];
  assert.deepEqual(evaluateGate(events, now, GATE), { ok: true });
});

test("evaluateGate: a prior proactive post counts as an assistant message (resets the counter)", () => {
  const now = 10_000;
  // The bot's prior proactive post is role 'assistant'; only 1 human msg follows it.
  const events = [
    ev("u1", 1000, "user"),
    ev("u2", 1500, "user"),
    ev("u3", 1800, "user"),
    ev("proactive-post", 2000, "assistant"),
    ev("u4", 3000, "user"),
  ];
  assert.deepEqual(evaluateGate(events, now, GATE), { ok: false, reason: "skip_sparse" });
});

test("proactiveGateScanLimit floors at 80 and grows with min_user_messages", () => {
  assert.equal(proactiveGateScanLimit(10), 80);
  assert.equal(proactiveGateScanLimit(100), 132);
});

// ── computeNextAttempt: mean spacing, jitter bounds, floor, spill ────

test("computeNextAttempt: mean spacing with jitter midpoint (random=0.5 → 1.0×)", () => {
  const now = 0;
  const windowEnd = 10_000;
  const next = computeNextAttempt({
    now,
    windowEnd,
    nextWindowOpen: 99_999,
    remaining: 5,
    minGapMs: 0,
    random: () => 0.5, // 0.5 + 0.5 = 1.0× mean
  });
  // mean = 10000/5 = 2000; gap = 2000 * 1.0 = 2000.
  assert.equal(next, 2000);
});

test("computeNextAttempt: jitter spans [0.5, 1.5)× of the mean", () => {
  const base = { now: 0, windowEnd: 12_000, nextWindowOpen: 99_999, remaining: 3, minGapMs: 0 };
  const mean = 12_000 / 3; // 4000
  const low = computeNextAttempt({ ...base, random: () => 0 }); // 0.5×
  const high = computeNextAttempt({ ...base, random: () => 0.999999 }); // ~1.5×
  assert.equal(low, mean * 0.5);
  assert.ok(high > mean * 1.49 && high < mean * 1.5, "upper bound approaches 1.5× but never reaches it");
});

test("computeNextAttempt: min_gap_ms floors the gap", () => {
  const next = computeNextAttempt({
    now: 1000,
    windowEnd: 2000, // tiny window → mean tiny
    nextWindowOpen: 50_000,
    remaining: 10,
    minGapMs: 5000,
    random: () => 0, // 0.5× of a tiny mean → below floor
  });
  // gap floored to 5000 → 1000+5000 = 6000, which is >= windowEnd → spill.
  assert.equal(next, 50_000, "flooring pushes past the window, so it spills to next open");
});

test("computeNextAttempt: spills to next window open when gap lands at/after window end", () => {
  const next = computeNextAttempt({
    now: 9_500,
    windowEnd: 10_000,
    nextWindowOpen: 100_000,
    remaining: 1,
    minGapMs: 0,
    random: () => 1.4, // mean=500, gap=500*1.9=950 → 10450 >= windowEnd
  });
  assert.equal(next, 100_000);
});

// ── resolveSchedulingWindow (UTC) ───────────────────────────────────

test("resolveSchedulingWindow: no active hours → full local day, next open = next midnight", () => {
  configureAgentTimezone("UTC");
  try {
    const now = Date.UTC(2026, 5, 2, 14, 0, 0); // 14:00 UTC
    const w = resolveSchedulingWindow(now, undefined);
    assert.equal(w.inWindow, true);
    assert.equal(w.windowEnd, Date.UTC(2026, 5, 3, 0, 0, 0));
    assert.equal(w.nextOpen, Date.UTC(2026, 5, 3, 0, 0, 0));
  } finally {
    resetAgentTimezone();
  }
});

test("resolveSchedulingWindow: inside a same-day active window", () => {
  configureAgentTimezone("UTC");
  try {
    const now = Date.UTC(2026, 5, 2, 12, 0, 0); // 12:00, window 09–17
    const w = resolveSchedulingWindow(now, { start: 9, end: 17 });
    assert.equal(w.inWindow, true);
    assert.equal(w.windowEnd, Date.UTC(2026, 5, 2, 17, 0, 0));
    assert.equal(w.nextOpen, Date.UTC(2026, 5, 3, 9, 0, 0), "next open is tomorrow's window");
  } finally {
    resetAgentTimezone();
  }
});

test("resolveSchedulingWindow: before today's window opens → not in window, arm at open", () => {
  configureAgentTimezone("UTC");
  try {
    const now = Date.UTC(2026, 5, 2, 6, 0, 0); // 06:00, before 09–17
    const w = resolveSchedulingWindow(now, { start: 9, end: 17 });
    assert.equal(w.inWindow, false);
    assert.equal(w.nextOpen, Date.UTC(2026, 5, 2, 9, 0, 0));
  } finally {
    resetAgentTimezone();
  }
});

test("resolveSchedulingWindow: wrapping window (end <= start) stays open past midnight", () => {
  configureAgentTimezone("UTC");
  try {
    // Window 22:00 → 02:00. At 00:30 we are inside yesterday's window.
    const now = Date.UTC(2026, 5, 2, 0, 30, 0);
    const w = resolveSchedulingWindow(now, { start: 22, end: 2 });
    assert.equal(w.inWindow, true);
    assert.equal(w.windowEnd, Date.UTC(2026, 5, 2, 2, 0, 0), "closes at 02:00 today");
  } finally {
    resetAgentTimezone();
  }
});

// ── Budget derivation via storage.countSessionsByType ────────────────

async function withStorage(run: (storage: Storage) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-proactive-db-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    await run(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("countSessionsByType: counts only matching type+timeline+since (NO_REPLY rows count)", async () => {
  await withStorage(async (storage) => {
    const since = 1_000_000;
    // Two proactive rows today (one of which is NO_REPLY → status completed, no_reply=1).
    await storage.insertAgentSession({
      id: "p1", timelineKey: TK, sessionType: "proactive", status: "completed",
      createdAt: since + 10, updatedAt: since + 10,
    });
    await storage.insertAgentSession({
      id: "p2", timelineKey: TK, sessionType: "proactive", status: "completed",
      createdAt: since + 20, updatedAt: since + 20,
    });
    await storage.updateAgentSessionStatus("p2", "completed", { completedAt: since + 21, noReply: true });
    // A row from before `since` (yesterday) — excluded.
    await storage.insertAgentSession({
      id: "p0", timelineKey: TK, sessionType: "proactive", status: "completed",
      createdAt: since - 5, updatedAt: since - 5,
    });
    // A default-type row today — excluded.
    await storage.insertAgentSession({
      id: "d1", timelineKey: TK, sessionType: "default", status: "completed",
      createdAt: since + 30, updatedAt: since + 30,
    });
    // A proactive row in another timeline — excluded.
    await storage.insertAgentSession({
      id: "x1", timelineKey: "matrix:miku:room:!other:server", sessionType: "proactive",
      status: "completed", createdAt: since + 40, updatedAt: since + 40,
    });

    assert.equal(storage.countSessionsByType(TK, "proactive", since), 2);
  });
});

// ── TriggerCoordinator.tryAcquire (no-queue) ─────────────────────────

test("tryAcquire: claims a slot up to the limit, then refuses without enqueuing", () => {
  const coord = new TriggerCoordinator({
    max_concurrent: 1,
    max_concurrent_dm: 1,
    forced_completion_retries: 0,
  });
  assert.equal(coord.tryAcquire(TK), true, "first acquire succeeds");
  assert.equal(coord.tryAcquire(TK), false, "second refused at the limit");
  assert.equal(coord.queuedCount(TK), 0, "nothing was enqueued");
  // Releasing frees the slot again.
  coord.complete(TK);
  assert.equal(coord.tryAcquire(TK), true, "slot reusable after complete");
});

// ── Typing suppression in the runner ─────────────────────────────────

test("SessionRunner: suppressTyping makes zero setTyping calls across send and NO_REPLY", async () => {
  let typingCalls = 0;
  const provider = {
    setTyping: async () => {
      typingCalls += 1;
    },
  } as any;
  const target = { provider: "matrix", timelineKey: TK } as any;

  // NO_REPLY path.
  const noReplyAgent = {
    state: { messages: [] as any[] },
    async prompt() {
      this.state.messages.push({ role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] });
    },
    async continue() {},
    async waitForIdle() {},
  };
  const runner = new SessionRunner({ provider, target, suppressTyping: true });
  const result = await runner.run(noReplyAgent as any, { id: "s-1" } as any, 0, { role: "user", content: "x", timestamp: 1 } as any);
  assert.equal(result.noReply, true);
  assert.equal(typingCalls, 0, "no typing indicator for a suppressed run");
});

// ── Integration: a full pass launches a proactive session ────────────

function noopLogger(): any {
  const l: any = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    child: () => l,
  };
  return l;
}

function schedulerConfig(): AppConfig {
  return {
    app: { name: "t", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" },
    agent: { sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 }, system: {} },
    models: { default: { id: "m", provider: "p", endpoint: "e", api_key: "k", multimodal: false, max_tokens: 1 } },
    context: { tiers: { rich_target_tokens: 1, rich_max_tokens: 1, compact_target_tokens: 1, compact_max_tokens: 1 } },
    storage: { database_path: ":memory:" },
    workspace: { root_dir: "/tmp" },
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: { miku: { homeserver: "h", user_id: "@miku:server", store_path: "/tmp" } } },
    proactive: {
      enabled: true,
      session_type: "proactive",
      // Tiny mean + zero floor so the first arm fires within a few ms under mock timers.
      daily_posts: 1_000_000,
      min_gap_ms: 0,
      min_user_messages: 1,
      dead_channel_backstop_ms: 6 * 3_600_000,
      channels: [{ timeline_key: TK }],
    },
  } as AppConfig;
}

test("ProactiveScheduler: a full pass acquires a slot and launches a proactive session", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  configureAgentTimezone("UTC");
  t.after(() => resetAgentTimezone());

  const now = Date.UTC(2026, 5, 2, 12, 0, 0);
  const launches: Array<{ inbound: InboundChatEvent; opts: { proactive: true } }> = [];

  // tryAcquire succeeds once, then refuses — bounds the integration to one launch
  // even though mock-timer advancement fires several reschedules.
  let acquires = 0;
  const triggerCoordinator: any = {
    tryAcquire: () => (acquires++ === 0),
    complete: () => undefined,
  };
  const storage: any = { countSessionsByType: () => 0 };
  const sessions: any = { activeForTimeline: () => [] };
  const timeline: any = {
    query: () => [
      ev("u1", now - 1000, "user"),
      ev("u2", now - 500, "user"),
    ],
  };

  const scheduler = new ProactiveScheduler({
    config: schedulerConfig(),
    timeline,
    sessions,
    triggerCoordinator,
    storage,
    launchSession: (inbound, _dup, opts) => launches.push({ inbound, opts }),
    isDraining: () => false,
    logger: noopLogger(),
    now: () => now,
    random: () => 0,
  });

  scheduler.start();
  t.mock.timers.tick(500); // fire the first armed tick(s)
  scheduler.stop();

  assert.equal(launches.length, 1, "exactly one proactive session launched");
  assert.equal(launches[0]!.opts.proactive, true);
  const inbound = launches[0]!.inbound;
  assert.equal(inbound.trigger?.type, "timer");
  assert.equal(inbound.trigger?.reason, "proactive");
  assert.equal(inbound.outboundTarget?.roomId, "!room:server");
  assert.equal(inbound.outboundTarget?.accountId, "miku");
  assert.ok(inbound.event.id.startsWith("proactive-"));
  assert.equal(inbound.event.sender.isSelf, true);
});

test("ProactiveScheduler: inert when disabled or no channels (start is a no-op)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cfg = schedulerConfig();
  cfg.proactive!.enabled = false;
  let launched = 0;
  const scheduler = new ProactiveScheduler({
    config: cfg,
    timeline: { query: () => [] } as any,
    sessions: { activeForTimeline: () => [] } as any,
    triggerCoordinator: { tryAcquire: () => true, complete: () => undefined } as any,
    storage: { countSessionsByType: () => 0 } as any,
    launchSession: () => { launched++; },
    isDraining: () => false,
    logger: noopLogger(),
    now: () => 0,
    random: () => 0,
  });
  assert.equal(scheduler.active, false);
  scheduler.start();
  t.mock.timers.tick(10_000_000);
  scheduler.stop();
  assert.equal(launched, 0);
});
