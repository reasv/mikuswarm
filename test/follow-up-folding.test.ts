import test from "node:test";
import assert from "node:assert/strict";

import {
  FollowUpWatch,
  classifyFollowUpForm,
  followUpGateDecision,
  followUpConfigActive,
  hasImageAttachment,
  maxWallClockMs,
  decideFollowUpRoute,
  type FollowUpConfig,
} from "../src/agent/follow-up-watch.js";
import { convertToLlm } from "../src/agent/convert.js";
import { evaluateFollowUpResumeGate, assertFollowupConfigValid } from "../src/app.ts";
import type { ResumeMaterial } from "../src/agent/index.ts";
import type { AgentSessionRow } from "../src/storage/index.ts";
import type { CanonicalChatEvent } from "../src/types.js";

const TK = "matrix:miku:room:!room:server.org";
const DM = "matrix:miku:dm:!dm:server.org";

function event(over: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id: "evt-1",
    externalId: "$m1",
    timelineKey: TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:server.org", displayName: "Alice" },
    body: "hi",
    timestamp: 1_000_000,
    receivedAt: 1_000_000,
    ...over,
  };
}

// The default-shipped lever windows (00-defaults.toml): media 10s/30s, text 7s/15s,
// mention 5s/12s, all enabled.
function defaultConfig(over: Partial<FollowUpConfig> = {}): FollowUpConfig {
  return {
    media: { enabled: true, userGapMs: 10_000, wallClockMs: 30_000 },
    text: { enabled: true, userGapMs: 7_000, wallClockMs: 15_000 },
    mention: { enabled: true, userGapMs: 5_000, wallClockMs: 12_000 },
    ...over,
  };
}

// ── classifyFollowUpForm (§2) ────────────────────────────────────────────────

test("classifyFollowUpForm: @-mention dominates (mention), even with an image", () => {
  assert.equal(
    classifyFollowUpForm(event({ mentions: { mentionedUserIds: [], mentionedSelf: true } })),
    "mention",
  );
  // An image-bearing re-@ is still mention (the @ is the explicit address; tightest window).
  assert.equal(
    classifyFollowUpForm(
      event({
        mentions: { mentionedUserIds: [], mentionedSelf: true },
        attachments: [{ id: "a", mediaType: "image", localPath: "/x.png" }],
      }),
    ),
    "mention",
  );
});

test("classifyFollowUpForm: image without @ is media", () => {
  assert.equal(
    classifyFollowUpForm(event({ attachments: [{ id: "a", mediaType: "image" }] })),
    "media",
  );
  // A non-image attachment does NOT make it media — falls through to text.
  assert.equal(
    classifyFollowUpForm(event({ attachments: [{ id: "a", mediaType: "file" }] })),
    "text",
  );
});

test("classifyFollowUpForm: bare text (no @, no image) is text", () => {
  assert.equal(classifyFollowUpForm(event()), "text");
  assert.equal(
    classifyFollowUpForm(event({ mentions: { mentionedUserIds: ["@bob:server.org"], mentionedSelf: false } })),
    "text",
  );
});

test("hasImageAttachment: true only for an image attachment", () => {
  assert.equal(hasImageAttachment(event()), false);
  assert.equal(hasImageAttachment(event({ attachments: [{ id: "a", mediaType: "video" }] })), false);
  assert.equal(hasImageAttachment(event({ attachments: [{ id: "a", mediaType: "image" }] })), true);
});

// ── followUpGateDecision (§4 two-clock gate) ─────────────────────────────────

test("followUpGateDecision: both clocks must pass", () => {
  const config = defaultConfig();
  const base = { config, triggerOriginTs: 1_000_000, armedAtWallClock: 5_000_000 };
  // media: user-gap 9s (≤10s), wall-clock 20s (≤30s) → pass.
  assert.equal(
    followUpGateDecision({ ...base, form: "media", followUpOriginTs: 1_009_000, now: 5_020_000 }),
    true,
  );
  // user-gap 11s > 10s → fail (even with wall-clock fine).
  assert.equal(
    followUpGateDecision({ ...base, form: "media", followUpOriginTs: 1_011_000, now: 5_005_000 }),
    false,
  );
  // wall-clock 31s > 30s → fail (even with user-gap fine).
  assert.equal(
    followUpGateDecision({ ...base, form: "media", followUpOriginTs: 1_005_000, now: 5_031_000 }),
    false,
  );
});

test("followUpGateDecision: windows tighten media > text > mention", () => {
  const config = defaultConfig();
  const base = { config, triggerOriginTs: 1_000_000, armedAtWallClock: 5_000_000, now: 5_001_000 };
  // An 8s user-gap: passes media (10s) and... fails text (7s) and mention (5s).
  assert.equal(followUpGateDecision({ ...base, form: "media", followUpOriginTs: 1_008_000 }), true);
  assert.equal(followUpGateDecision({ ...base, form: "text", followUpOriginTs: 1_008_000 }), false);
  assert.equal(followUpGateDecision({ ...base, form: "mention", followUpOriginTs: 1_008_000 }), false);
  // A 6s user-gap: passes media + text, fails mention.
  assert.equal(followUpGateDecision({ ...base, form: "text", followUpOriginTs: 1_006_000 }), true);
  assert.equal(followUpGateDecision({ ...base, form: "mention", followUpOriginTs: 1_006_000 }), false);
});

test("followUpGateDecision: a disabled lever never passes", () => {
  const config = defaultConfig({ media: { enabled: false, userGapMs: 10_000, wallClockMs: 30_000 } });
  assert.equal(
    followUpGateDecision({
      config,
      form: "media",
      triggerOriginTs: 1_000_000,
      followUpOriginTs: 1_001_000,
      armedAtWallClock: 5_000_000,
      now: 5_001_000,
    }),
    false,
  );
});

test("followUpGateDecision: the user-gap is symmetric (abs diff)", () => {
  // A follow-up whose origin ts is BEFORE the trigger's (clock skew / reorder) still
  // gates on |diff|, not a signed value.
  assert.equal(
    followUpGateDecision({
      config: defaultConfig(),
      form: "media",
      triggerOriginTs: 1_010_000,
      followUpOriginTs: 1_001_000, // 9s earlier
      armedAtWallClock: 5_000_000,
      now: 5_001_000,
    }),
    true,
  );
});

// ── config helpers ───────────────────────────────────────────────────────────

test("followUpConfigActive: true iff some lever is enabled", () => {
  assert.equal(followUpConfigActive(defaultConfig()), true);
  assert.equal(
    followUpConfigActive({
      media: { enabled: false, userGapMs: 0, wallClockMs: 0 },
      text: { enabled: false, userGapMs: 0, wallClockMs: 0 },
      mention: { enabled: false, userGapMs: 0, wallClockMs: 0 },
    }),
    false,
  );
});

test("maxWallClockMs: the widest lever's wall_clock (GC lifetime)", () => {
  assert.equal(maxWallClockMs(defaultConfig()), 30_000);
});

test("maxWallClockMs: a disabled wide lever does NOT inflate the GC lifetime", () => {
  // media (widest, 30s) disabled but its window left at the default → the lifetime is
  // the widest ENABLED lever (text, 15s), not 30s. A disabled lever never admits a fold,
  // so its window must not extend retention.
  assert.equal(maxWallClockMs(defaultConfig({ media: { enabled: false, userGapMs: 10_000, wallClockMs: 30_000 } })), 15_000);
});

// ── decideFollowUpRoute (§5 / §2 delivery table) ─────────────────────────────

test("decideFollowUpRoute: running + agent attached → steer", () => {
  assert.equal(
    decideFollowUpRoute({ recordPresent: true, recordStatus: "running", agentAttached: true, rowCompleted: false }),
    "steer",
  );
});

test("decideFollowUpRoute: running but agent NOT attached → park (drained at go-live)", () => {
  assert.equal(
    decideFollowUpRoute({ recordPresent: true, recordStatus: "running", agentAttached: false, rowCompleted: false }),
    "park",
  );
});

test("decideFollowUpRoute: created (pre-live) → park, regardless of agent flag", () => {
  assert.equal(
    decideFollowUpRoute({ recordPresent: true, recordStatus: "created", agentAttached: false, rowCompleted: false }),
    "park",
  );
  // A created record never has an attached agent, but assert the route is park even if
  // the flag were somehow set — `steer` requires status === "running".
  assert.equal(
    decideFollowUpRoute({ recordPresent: true, recordStatus: "created", agentAttached: true, rowCompleted: false }),
    "park",
  );
});

test("decideFollowUpRoute: owner gone + durable row completed → resume", () => {
  assert.equal(
    decideFollowUpRoute({ recordPresent: false, recordStatus: undefined, agentAttached: false, rowCompleted: true }),
    "resume",
  );
});

test("decideFollowUpRoute: owner gone + row NOT completed → none (native fate)", () => {
  // discarded / interrupted / failed / pruned / absent → not fold-resumable.
  assert.equal(
    decideFollowUpRoute({ recordPresent: false, recordStatus: undefined, agentAttached: false, rowCompleted: false }),
    "none",
  );
});

test("decideFollowUpRoute: a live record outranks the durable row (steer/park win over resume)", () => {
  // Settle race: the in-memory record is still running while the row already flipped to
  // completed — the live record wins (steer), never resume.
  assert.equal(
    decideFollowUpRoute({ recordPresent: true, recordStatus: "running", agentAttached: true, rowCompleted: true }),
    "steer",
  );
});

test("decideFollowUpRoute: a present record in a terminal status falls through to the row", () => {
  // record present but neither created nor running (e.g. interrupted, pending evict):
  // the route is decided by the durable row, exactly as if the record were gone.
  assert.equal(
    decideFollowUpRoute({ recordPresent: true, recordStatus: "interrupted", agentAttached: false, rowCompleted: true }),
    "resume",
  );
  assert.equal(
    decideFollowUpRoute({ recordPresent: true, recordStatus: "interrupted", agentAttached: false, rowCompleted: false }),
    "none",
  );
});

// ── assertFollowupConfigValid (§9 cross-field) ───────────────────────────────

test("assertFollowupConfigValid: an absent block is valid (folding unconfigured)", () => {
  assert.doesNotThrow(() => assertFollowupConfigValid(undefined));
});

test("assertFollowupConfigValid: the shipped-shape defaults pass", () => {
  assert.doesNotThrow(() =>
    assertFollowupConfigValid({
      media: { enabled: true, user_gap_ms: 10_000, wall_clock_ms: 30_000 },
      text: { enabled: true, user_gap_ms: 7_000, wall_clock_ms: 15_000 },
      mention: { enabled: true, user_gap_ms: 5_000, wall_clock_ms: 12_000 },
    }),
  );
});

test("assertFollowupConfigValid: wall_clock_ms < user_gap_ms is rejected (#5)", () => {
  assert.throws(
    () => assertFollowupConfigValid({ text: { enabled: true, user_gap_ms: 7_000, wall_clock_ms: 5_000 } }),
    /wall_clock_ms \(5000\) must be >= user_gap_ms \(7000\)/,
  );
});

test("assertFollowupConfigValid: a user_gap_ms with no wall_clock_ms is rejected (#8 dead-lever guard)", () => {
  assert.throws(
    () => assertFollowupConfigValid({ media: { enabled: true, user_gap_ms: 10_000 } }),
    /user_gap_ms is set but wall_clock_ms is missing/,
  );
});

// ── FollowUpWatch registry (§4.1) ────────────────────────────────────────────

function fakeTimers() {
  let nowMs = 0;
  const scheduled = new Map<number, { fn: () => void; at: number }>();
  let nextId = 1;
  return {
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
      for (const [id, { fn, at }] of [...scheduled]) {
        if (at <= nowMs) {
          scheduled.delete(id);
          fn();
        }
      }
    },
    schedule: ((fn: () => void, ms: number) => {
      const id = nextId++;
      scheduled.set(id, { fn, at: nowMs + ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as (fn: () => void, ms: number) => ReturnType<typeof setTimeout>,
    cancel: ((timer: ReturnType<typeof setTimeout>) => {
      scheduled.delete(timer as unknown as number);
    }) as (timer: ReturnType<typeof setTimeout>) => void,
    pending: () => scheduled.size,
  };
}

test("FollowUpWatch: arm + get round-trips, get is per (timeline, sender)", () => {
  const t = fakeTimers();
  const watch = new FollowUpWatch(30_000, t.now, t.schedule, t.cancel);
  watch.arm(TK, "@alice:server.org", { sessionId: "s1", triggerOriginTs: 100, armedAtWallClock: 0 });
  assert.equal(watch.get(TK, "@alice:server.org")?.sessionId, "s1");
  // Different sender / timeline → nothing.
  assert.equal(watch.get(TK, "@bob:server.org"), undefined);
  assert.equal(watch.get(DM, "@alice:server.org"), undefined);
});

test("FollowUpWatch: most-recent arm overwrites and resets the GC timer", () => {
  const t = fakeTimers();
  const watch = new FollowUpWatch(30_000, t.now, t.schedule, t.cancel);
  watch.arm(TK, "@alice:server.org", { sessionId: "s1", triggerOriginTs: 100, armedAtWallClock: 0 });
  t.advance(20_000);
  watch.arm(TK, "@alice:server.org", { sessionId: "s2", triggerOriginTs: 200, armedAtWallClock: 20_000 });
  assert.equal(watch.get(TK, "@alice:server.org")?.sessionId, "s2");
  assert.equal(t.pending(), 1, "the superseded timer was cancelled");
  // 20s more (40s since the FIRST arm, 20s since the second) → second still live.
  t.advance(20_000);
  assert.equal(watch.get(TK, "@alice:server.org")?.sessionId, "s2");
});

test("FollowUpWatch: GC timer evicts after the lifetime", () => {
  const t = fakeTimers();
  const watch = new FollowUpWatch(30_000, t.now, t.schedule, t.cancel);
  watch.arm(TK, "@alice:server.org", { sessionId: "s1", triggerOriginTs: 100, armedAtWallClock: 0 });
  t.advance(30_001);
  assert.equal(watch.get(TK, "@alice:server.org"), undefined);
  assert.equal(watch.size, 0);
});

test("FollowUpWatch: get lazily evicts a stale entry even before its timer fires", () => {
  // Schedule no-op so the GC timer never fires; the lazy wall-clock check still evicts.
  const noopSchedule = ((_fn: () => void) => 0 as unknown as ReturnType<typeof setTimeout>) as (
    fn: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  let nowMs = 0;
  const watch = new FollowUpWatch(30_000, () => nowMs, noopSchedule, () => {});
  watch.arm(TK, "@alice:server.org", { sessionId: "s1", triggerOriginTs: 100, armedAtWallClock: 0 });
  nowMs = 30_001;
  assert.equal(watch.get(TK, "@alice:server.org"), undefined);
});

test("FollowUpWatch: an inert (lifetime 0) registry never arms", () => {
  const watch = new FollowUpWatch(0);
  watch.arm(TK, "@alice:server.org", { sessionId: "s1", triggerOriginTs: 100, armedAtWallClock: 0 });
  assert.equal(watch.get(TK, "@alice:server.org"), undefined);
  assert.equal(watch.size, 0);
});

test("FollowUpWatch: clear drops all entries + timers", () => {
  const t = fakeTimers();
  const watch = new FollowUpWatch(30_000, t.now, t.schedule, t.cancel);
  watch.arm(TK, "@alice:server.org", { sessionId: "s1", triggerOriginTs: 100, armedAtWallClock: 0 });
  watch.arm(DM, "@bob:server.org", { sessionId: "s2", triggerOriginTs: 100, armedAtWallClock: 0 });
  watch.clear();
  assert.equal(watch.size, 0);
  assert.equal(t.pending(), 0);
});

// ── Interjection image pixels (§3) ───────────────────────────────────────────

test("convertToLlm: an interjection WITHOUT imageBlocks stays a bare string", () => {
  const [msg] = convertToLlm([{ type: "interjection", content: "look" } as any]);
  assert.equal(typeof (msg as any).content, "string");
  assert.match((msg as any).content, /^<interjection>\nlook\n<\/interjection>$/);
});

test("convertToLlm: an interjection WITH imageBlocks carries real image content blocks (§3)", () => {
  const [msg] = convertToLlm([
    {
      type: "interjection",
      content: "look at this",
      imageBlocks: [
        { eventId: "e", attachmentId: "a", mediaType: "image/png", dataBase64: "QUJD" },
      ],
    } as any,
  ]);
  const content = (msg as any).content;
  assert.ok(Array.isArray(content), "content is a block array, not a string");
  assert.equal(content[0].type, "text");
  assert.match(content[0].text, /<interjection>\nlook at this\n<\/interjection>/);
  assert.equal(content[1].type, "image");
  assert.equal(content[1].data, "QUJD");
  assert.equal(content[1].mimeType, "image/png");
});

// ── evaluateFollowUpResumeGate (§5.3) ────────────────────────────────────────

function completedRow(over: Partial<AgentSessionRow> = {}): AgentSessionRow {
  return {
    id: "s1",
    timeline_key: TK,
    session_type: "default",
    status: "completed",
    model_id: "test-model",
    trigger_event_id: "t1",
    trigger_external_id: "$t1",
    trigger_body: "look at this",
    trigger_sender_id: "@alice:server.org",
    trigger_sender_display_name: "Alice",
    context_snapshot_json: "[]",
    context_dump_path: null,
    transcript_json: "[]",
    token_estimate: 100,
    llm_requests: 1,
    usage_input_tokens: 10,
    usage_output_tokens: 10,
    usage_cache_read_tokens: 0,
    usage_cache_write_tokens: 0,
    usage_cost: 0,
    context_tokens: 500,
    resume_generation: 0,
    no_reply: 0,
    error: null,
    created_at: 0,
    started_at: 0,
    updated_at: 0,
    completed_at: 0,
    chat_upper_bound_ts: 0,
    ...over,
  } as AgentSessionRow;
}

const MATERIAL: ResumeMaterial = { snapshot: [], transcript: [{ role: "user", content: "x" } as any] };
const okGate = {
  resolveCeiling: () => undefined,
  loadMaterial: async () => MATERIAL,
  timelineKey: TK,
  logger: { warn() {} },
};

test("evaluateFollowUpResumeGate: a completed, viable row resumes — NO work gate", async () => {
  // A toolless pure-chat session (the work gate would REJECT this for reply-resume) is
  // exactly what a follow-up resumes — the gate must NOT scan for work (§5.3).
  const verdict = await evaluateFollowUpResumeGate({
    sessionId: "s1",
    getSession: () => completedRow(),
    ...okGate,
  });
  assert.equal(verdict.resume, true);
});

test("evaluateFollowUpResumeGate: only `completed` is resumable", async () => {
  for (const status of ["discarded", "failed-resumable", "interrupted", "running"] as const) {
    const verdict = await evaluateFollowUpResumeGate({
      sessionId: "s1",
      getSession: () => completedRow({ status }),
      ...okGate,
    });
    assert.equal(verdict.resume, false, `status ${status} must not resume`);
  }
  // A pruned / missing row → no resume.
  assert.equal(
    (await evaluateFollowUpResumeGate({ sessionId: "s1", getSession: () => undefined, ...okGate })).resume,
    false,
  );
});

test("evaluateFollowUpResumeGate: synthetic worker session types are excluded", async () => {
  for (const sessionType of ["summarize", "condense", "diary"]) {
    const verdict = await evaluateFollowUpResumeGate({
      sessionId: "s1",
      getSession: () => completedRow({ session_type: sessionType }),
      ...okGate,
    });
    assert.equal(verdict.resume, false, `${sessionType} must not resume`);
  }
});

test("evaluateFollowUpResumeGate: capability/context-ceiling gate (KEEP, §5.3)", async () => {
  // At/over the ceiling → a resume would instantly re-park → native fate instead.
  const atCeiling = await evaluateFollowUpResumeGate({
    sessionId: "s1",
    getSession: () => completedRow({ context_tokens: 1000 }),
    ...okGate,
    resolveCeiling: () => 1000,
  });
  assert.equal(atCeiling.resume, false);
  // Comfortably under → resumes.
  const underCeiling = await evaluateFollowUpResumeGate({
    sessionId: "s1",
    getSession: () => completedRow({ context_tokens: 500 }),
    ...okGate,
    resolveCeiling: () => 1000,
  });
  assert.equal(underCeiling.resume, true);
});

test("evaluateFollowUpResumeGate: missing/corrupt material → no resume", async () => {
  const verdict = await evaluateFollowUpResumeGate({
    sessionId: "s1",
    getSession: () => completedRow(),
    ...okGate,
    loadMaterial: async () => null,
  });
  assert.equal(verdict.resume, false);
});

test("evaluateFollowUpResumeGate: ANY throw degrades to no-resume, never propagates (throw-safe)", async () => {
  let warned = false;
  const verdict = await evaluateFollowUpResumeGate({
    sessionId: "s1",
    getSession: () => {
      throw new Error("db exploded");
    },
    resolveCeiling: () => undefined,
    loadMaterial: async () => MATERIAL,
    timelineKey: TK,
    logger: { warn: () => { warned = true; } },
  });
  assert.equal(verdict.resume, false);
  assert.equal(warned, true);
  // A ceiling-resolution throw is individually contained → gate stays inert, not failed.
  const ceilingThrew = await evaluateFollowUpResumeGate({
    sessionId: "s1",
    getSession: () => completedRow({ context_tokens: 999_999 }),
    ...okGate,
    resolveCeiling: () => {
      throw new Error("ceiling lookup failed");
    },
  });
  assert.equal(ceilingThrew.resume, true, "a ceiling throw is treated as 'no ceiling', not a gate failure");
});

// ── foldFollowUp precedence (faithful model, §6 single-consumption + §5 routing) ──
//
// Models the synchronous `foldFollowUp` fork in handleInbound (src/app.ts): the guard
// chain (reply-skip → self-skip → watch lookup → trigger-hold raw-skip → dedup → gate)
// then the route dispatch. The pieces it composes are the REAL ones — a real
// `FollowUpWatch`, a real `steeredEventIds` Set, `classifyFollowUpForm`,
// `followUpGateDecision`, `decideFollowUpRoute`; only the control-flow ordering is
// reproduced here (the live function fires detached deliveries this model does not).
// Mirrors the duplicate-reply-mitigation `admit` model.

type FoldOutcome = "skip" | "deduped" | "steer" | "park" | "resume" | "none";

function fold(args: {
  watch: FollowUpWatch;
  steered: Set<string>;
  config: FollowUpConfig;
  inbound: CanonicalChatEvent;
  /** `inbound.trigger` present — the POST-HOLD delivery of a trigger-bearing follow-up. */
  trigger: boolean;
  /** DM || mentionedSelf — the set of follow-ups that double-deliver (raw + post-hold). */
  wouldTrigger: boolean;
  owner: { recordPresent: boolean; recordStatus?: string; agentAttached?: boolean; rowCompleted?: boolean };
  now: number;
}): FoldOutcome {
  const ev = args.inbound;
  if (ev.replyTo?.externalId) return "skip"; // replies keep their own (reply/co-target/resume) path
  if (ev.sender.isSelf) return "skip";
  if (!ev.sender.id) return "skip";
  const w = args.watch.get(ev.timelineKey, ev.sender.id);
  if (!w) return "skip"; // no armed watch → inert (bare group follow-up with no prior session)
  if (args.wouldTrigger && !args.trigger) return "skip"; // raw delivery of a trigger-bearing follow-up
  if (args.steered.has(ev.id)) return "deduped"; // trigger-hold twin already consumed
  const passes = followUpGateDecision({
    form: classifyFollowUpForm(ev),
    config: args.config,
    triggerOriginTs: w.triggerOriginTs,
    followUpOriginTs: ev.timestamp,
    armedAtWallClock: w.armedAtWallClock,
    now: args.now,
  });
  if (!passes) return "skip";
  const route = decideFollowUpRoute({
    recordPresent: args.owner.recordPresent,
    recordStatus: args.owner.recordStatus,
    agentAttached: !!args.owner.agentAttached,
    rowCompleted: !!args.owner.rowCompleted,
  });
  if (route !== "none") args.steered.add(ev.id); // consumed exactly once (markSteered)
  return route;
}

function armedWatch(): FollowUpWatch {
  // A real registry, armed for @alice with a trigger at t=1_000_000; deterministic fake
  // timer (now()===0) so nothing GC-evicts mid-test.
  const w = new FollowUpWatch(30_000, () => 0, () => 1 as unknown as ReturnType<typeof setTimeout>, () => {});
  w.arm(TK, "@alice:server.org", { sessionId: "s1", triggerOriginTs: 1_000_000, armedAtWallClock: 0 });
  return w;
}
const RUNNING_ATTACHED = { recordPresent: true, recordStatus: "running", agentAttached: true } as const;

test("fold: a reply is never folded — it keeps its own path (bare-only scoping, §6)", () => {
  assert.equal(
    fold({
      watch: armedWatch(), steered: new Set(), config: defaultConfig(),
      inbound: event({ replyTo: { externalId: "$target" }, timestamp: 1_002_000 }),
      trigger: false, wouldTrigger: false, owner: RUNNING_ATTACHED, now: 1_000,
    }),
    "skip",
  );
});

test("fold: the bot's own message is never folded", () => {
  assert.equal(
    fold({
      watch: armedWatch(), steered: new Set(), config: defaultConfig(),
      inbound: event({ sender: { id: "@miku:server.org", displayName: "Miku", isSelf: true }, timestamp: 1_002_000 }),
      trigger: false, wouldTrigger: false, owner: RUNNING_ATTACHED, now: 1_000,
    }),
    "skip",
  );
});

test("fold: no armed watch → inert (a bare group follow-up with no prior session)", () => {
  const unarmed = new FollowUpWatch(30_000, () => 0, () => 1 as unknown as ReturnType<typeof setTimeout>, () => {});
  assert.equal(
    fold({
      watch: unarmed, steered: new Set(), config: defaultConfig(),
      inbound: event({ timestamp: 1_002_000 }),
      trigger: false, wouldTrigger: false, owner: RUNNING_ATTACHED, now: 1_000,
    }),
    "skip",
  );
});

test("fold: an armed watch + a quick bare-text group follow-up → steer (group non-trigger capture)", () => {
  assert.equal(
    fold({
      watch: armedWatch(), steered: new Set(), config: defaultConfig(),
      inbound: event({ timestamp: 1_003_000 }), // 3s after trigger (text gap 7s)
      trigger: false, wouldTrigger: false, owner: RUNNING_ATTACHED, now: 2_000,
    }),
    "steer",
  );
});

test("fold: DM raw-vs-post-hold dedup — the raw delivery skips, the post-hold one folds (§6)", () => {
  const steered = new Set<string>();
  const watch = armedWatch();
  const common = { watch, steered, config: defaultConfig(), wouldTrigger: true, owner: RUNNING_ATTACHED, now: 2_000 } as const;
  // Raw delivery (trigger stripped) of a DM follow-up → skipped; it does NOT mark the
  // event, so the post-hold delivery can still fold it.
  assert.equal(fold({ ...common, inbound: event({ timestamp: 1_003_000 }), trigger: false }), "skip");
  assert.equal(steered.has("evt-1"), false, "the raw skip leaves the event unconsumed");
  // Post-hold delivery (trigger present) → folds (steer) and consumes the event id.
  assert.equal(fold({ ...common, inbound: event({ timestamp: 1_003_000 }), trigger: true }), "steer");
  assert.ok(steered.has("evt-1"), "the folded event is marked consumed exactly once");
});

test("fold: a re-delivered (already-consumed) event is deduped, not re-folded", () => {
  assert.equal(
    fold({
      watch: armedWatch(), steered: new Set(["evt-1"]), config: defaultConfig(),
      inbound: event({ timestamp: 1_003_000 }), trigger: true, wouldTrigger: true, owner: RUNNING_ATTACHED, now: 2_000,
    }),
    "deduped",
  );
});

test("fold: a follow-up outside the user-gap window → skip (gate rejects)", () => {
  assert.equal(
    fold({
      watch: armedWatch(), steered: new Set(), config: defaultConfig(),
      inbound: event({ timestamp: 1_009_000 }), // 9s after trigger — outside the 7s text gap
      trigger: false, wouldTrigger: false, owner: RUNNING_ATTACHED, now: 2_000,
    }),
    "skip",
  );
});

test("fold: a settled (completed) owner → resume; a non-resumable settled owner → none", () => {
  assert.equal(
    fold({
      watch: armedWatch(), steered: new Set(), config: defaultConfig(),
      inbound: event({ timestamp: 1_003_000 }), trigger: false, wouldTrigger: false,
      owner: { recordPresent: false, rowCompleted: true }, now: 2_000,
    }),
    "resume",
  );
  assert.equal(
    fold({
      watch: armedWatch(), steered: new Set(), config: defaultConfig(),
      inbound: event({ timestamp: 1_003_000 }), trigger: false, wouldTrigger: false,
      owner: { recordPresent: false, rowCompleted: false }, now: 2_000,
    }),
    "none",
  );
});

test("fold: a pre-attach (building) owner → park, drained when it goes live", () => {
  assert.equal(
    fold({
      watch: armedWatch(), steered: new Set(), config: defaultConfig(),
      inbound: event({ timestamp: 1_003_000 }), trigger: false, wouldTrigger: false,
      owner: { recordPresent: true, recordStatus: "running", agentAttached: false }, now: 2_000,
    }),
    "park",
  );
});
