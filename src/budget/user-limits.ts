// =============================================================================
// UserLimitEngine (spec PER-USER-LIMITS §8.2). A sibling to BudgetEngine for the
// HUMAN-triggered agent loop only — partitioned per-user / shared-pool counters,
// a per-field cascade, and the affordability estimate that drives per-attempt
// model selection / degradation.
//
// Three orthogonal layers (§2):
//   - Budget (§3): a partitioned constraint SET, ANDed. Fungible total + optional
//     per-model sub-caps; multi-window; per-`(meter)` running counters seeded from
//     the `usage_events` ledger. The partition template (§3.5) generalizes the
//     per-user `{user_id}` default to shared pools.
//   - Estimation (§5): given a model + the live counters, can it complete a turn
//     within remaining budget right now? Output is bounded by CAPPING, not
//     prediction (`max_tokens` ← remaining headroom); the only estimate is the
//     input cost, dominated by the measured prior context.
//   - Selection (§4): lives in the FACTORY (it owns health + fits + the built
//     fallbacks). This engine answers predicate 1 (affordable) via `affordable`;
//     the factory composes predicates 2 (healthy) + 3 (fits).
//
// Counting identity under fallback (§7): GATE on the requested virtual model,
// COUNT the actual served cost, key the partition on the requested model. The
// per-user counters therefore scope on `requested_model_id` (recorded by the
// agent loop), so an outage backup still counts toward its requested sub-cap.
// =============================================================================

import type { Logger } from "../observability/logger.js";
import type { UsageCostFilter, UsageIdentity } from "../storage/database.js";
import { type WindowSpec, resolveWindow } from "./window.js";

// ─── Trigger context (§10) ───────────────────────────────────────────────────

/** Built once at Gate A from `inbound` (spec §10); frozen on the session. */
export interface UserLimitContext {
  userId: string;
  roomId?: string;
  /**
   * The triggering room's parent space ids (spec §11), best-first — a `space`
   * predicate matches if ANY entry matches, and the first is the canonical parent
   * the `{space_id}` partition + the `space_id` ledger column use. Resolved at Gate A
   * only when a rule references space (else empty / undefined).
   */
  spaceIds?: string[];
}

// ─── Normalized rules (output of normalize-user-limits.ts) ────────────────────

/** One normalized constraint inside a rule's budget block (spec §3.1/§3.5). */
export interface NormalizedConstraint {
  /** Index within the rule (for stable diagnostics). */
  index: number;
  maxUsd: number;
  window: WindowSpec;
  /** Sub-cap model scope (REQUESTED virtual names). Undefined = fungible total. */
  models?: string[];
  /** Partition template (default `"{user_id}"`). */
  partition: string;
  /** True when `partition` is anything but the per-user `{user_id}` default. */
  shared: boolean;
}

/** A normalized `[[user_limits]]` rule (spec §8.1). */
export interface NormalizedUserLimitRule {
  /** Authored order (cascade precedence + stable meter/diagnostic ids). */
  order: number;
  /** Match globs (anchored fnmatch); undefined = wildcard. OR within a dimension. */
  user?: string[];
  room?: string[];
  space?: string[];
  /**
   * True when this rule carries a model-budget block (the `models`+`limits` unit,
   * incl. the `max_usd` shorthand or an explicit exempt). Drives the atomic
   * model-budget cascade (§8.1) — only a rule with a block contributes it.
   */
  hasBudgetBlock: boolean;
  /** Ordered preference set (REQUESTED registry names). Undefined = session default. */
  models?: string[];
  /** The constraint set (empty for an exempt block). */
  constraints: NormalizedConstraint[];
  /** Cascades INDEPENDENTLY of the budget block. */
  messageTemplate?: string;
  /**
   * Agent/account scope (spec MULTI-AGENT-SUPPORT §8): when set, this rule only
   * resolves for sessions whose `timeline_key` starts with one of these prefixes.
   * Constraints from this rule only count events from the matching accounts.
   * Absent = global (matches all sessions).
   */
  timelineKeyPrefixes?: string[];
}

// ─── Resolved (per-ctx) view ──────────────────────────────────────────────────

/** A constraint resolved against a concrete trigger ctx (partition rendered). */
export interface ResolvedConstraint {
  /** Global meter identity — same key ⇒ same shared counter (§3.5). */
  meterKey: string;
  cap: number;
  window: WindowSpec;
  /** Requested-model scope; undefined = fungible total (covers every model). */
  modelScope?: string[];
  /** Rendered partition key (e.g. `@alice:hs`, `staff`, `room:!x:hs`). */
  partitionKey: string;
  /** True when this is the per-user `{user_id}` partition (seeds off trigger_sender_id). */
  isUserPartition: boolean;
  /** Concrete room id when the rule is room-matched (sturdy room-narrowed seed, §16 Q2). */
  roomScope?: string;
  /** Canonical parent space id when the rule is space-matched (space-narrowed seed, §11). */
  spaceScope?: string;
  /** Source rule order + index (diagnostics / console). */
  source: { ruleOrder: number; index: number };
  /**
   * Console ladder sort key (§14): caps order by the rule's `models` PREFERENCE list, not
   * the authored constraint index. A single-model cap sorts at its model's preference
   * position; a composite (≥2 models) sorts right AFTER its last member, with singles
   * before composites at the same rung. Encoded `maxPrefIndex*1000 + memberCount`.
   */
  orderKey: number;
  /**
   * Agent/account scope (spec MULTI-AGENT-SUPPORT §8): when set, only events whose
   * `timeline_key` starts with one of these prefixes count toward this constraint.
   * Carried from the rule through to `SeedFilter`; included in the meterKey so scoped
   * and global constraints on the same partition/model/window get distinct counters.
   */
  timelineKeyPrefixes?: string[];
}

/** The cascade-resolved per-user budget + selection view for one trigger ctx. */
export interface UserLimitResolution {
  /** True when ANY rule matched the ctx (else the feature is inert for this user). */
  matched: boolean;
  /**
   * True when the per-user machinery is ACTIVE for this session: a covering rule
   * supplied a model set OR any constraint. False ⇒ default model, no per-user
   * caps (exempt or no covering budget block) — the factory takes its normal path.
   */
  active: boolean;
  /** Hard ban: a covering fungible total with cap 0, or an empty model set. */
  banned: boolean;
  /** Ordered preference set (REQUESTED names); undefined = session-type default. */
  models?: string[];
  constraints: ResolvedConstraint[];
  /**
   * The DISTINCT shared-pool partition keys this session may denormalize onto its
   * ledger rows (spec MULTI-SHARED-POOL §4) — the model-BLIND superset over every
   * shared constraint (empty when the session joins no shared pool). The exact,
   * model-AWARE subset a given event actually joins is computed per-event by
   * {@link UserLimitEngine.sharedPoolKeys} (a model-scoped shared sub-cap is joined
   * only when the event's requested model is in its scope). The recorder stamps the
   * first key on `usage_events.budget_partition` and spills the rest to
   * `usage_event_partitions` (Option A). A single rule may now declare several shared
   * pools (up to the normalizer's bound), so this is a set, not a scalar.
   */
  ledgerPartitionKeys: string[];
  /** Templated refusal (§12), resolved independently. */
  messageTemplate?: string;
}

// ─── Affordability estimate (§5.3) ────────────────────────────────────────────

export interface AffordabilityEstimate {
  /**
   * Tokens already present in the PRIOR request's prompt (spec §5.3) — a cache hit
   * (`cache_read`) when the prior request is within the prompt-cache TTL, otherwise
   * folded into the cache-write basis. Default 0 (the first request has no prior).
   */
  cachedTokens?: number;
  /**
   * NEW tokens since the prior request (the assistant's last output + tool results +
   * framing, tokenized exactly with the §9 primary tokenizer) — priced at
   * `cache_write`. On the first request this is the whole rendered context. Default 0.
   */
  newTokens?: number;
  /**
   * True when the prior request is within the prompt-cache TTL (~5 min) so its prompt
   * is still a cache hit; false (default) ⇒ price the whole input at cache-write
   * (conservative — slightly under-utilizes the cache, never under-charges, §5.3).
   */
  withinCacheTtl?: boolean;
}

export interface AffordabilityResult {
  /** False ⇒ the model cannot complete a turn within remaining budget (UNAFFORDABLE). */
  ok: boolean;
  /** Budget-derived output cap to set as the request's `max_tokens` (when `ok`). */
  maxOutput: number;
  /** The constraint with the least headroom for this model (the binding one). */
  binding?: ResolvedConstraint;
  /** Remaining headroom (USD) of the binding constraint; +Inf when uncapped. */
  remainingUsd: number;
}

// ─── Per-model cost rates (face cost of the REQUESTED model, §7) ──────────────

/** Per-MTok USD rates for a model's face cost (the requested virtual model). */
export interface ModelCostRates {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Cache-read rate (prompt-cache hit). 0/absent ⇒ falls back to `inputPerMTok`. */
  cacheReadPerMTok?: number;
  /** Cache-write rate (prompt-cache establish). 0/absent ⇒ falls back to `inputPerMTok`. */
  cacheWritePerMTok?: number;
}

export interface UserLimitEngineOptions {
  rules: NormalizedUserLimitRule[];
  /** Σ `cost_usd` of ledger rows matching a meter's seed filter within a window. */
  sumUsageCost: (filter: UsageCostFilter) => number;
  /** Earliest contributing `ts` for the accurate rolling reset ETA (off the hot path). */
  minUsageTs?: (filter: UsageCostFilter) => number | null;
  /**
   * Distinct spend identities in the ledger since a timestamp — drives startup meter
   * seeding (see {@link UserLimitEngine.seedFromLedger}). Optional, mirroring
   * `minUsageTs`: when omitted, meters are NOT pre-seeded and materialize lazily on the
   * first live gate/record for a partition (the pre-seeding restart-visibility gap).
   */
  listUsageIdentities?: (opts: {
    since: number;
    includeRoom: boolean;
    includeSpace: boolean;
  }) => UsageIdentity[];
  /** Face cost rates (per MTok) of a REQUESTED model, by logical id. */
  costRatesFor: (logicalId: string) => ModelCostRates | undefined;
  /** Model default `max_tokens`, by logical id — the upper bound on the output cap. */
  maxTokensFor: (logicalId: string) => number | undefined;
  /** Logical ids whose configured cost rate is zero (§5.3 bypass — always affordable). */
  zeroCostModelIds: Set<string>;
  /** Minimum affordable output below which a model can't complete a turn (§5.3). */
  viableMinOutputTokens: number;
  logger: Logger;
  /**
   * True when `id` is a user identity the enabled chat providers recognize — i.e. a real
   * human-sender id, not a synthetic/system sender (e.g. `"system"`). Used to decide
   * whether a sender is subject to per-user limits (Gate A) and whether its partition
   * should appear on the console. Supplied by the app at construction; the predicate is
   * the authority for identity shape across all enabled providers.
   */
  isUserIdentity: (id: string) => boolean;
  /**
   * The agent's OWN user ids (one per configured account). Per-user limits apply only
   * to human triggers that pass Gate A — proactive / background / self / system sessions
   * skip it (ARCHITECTURE.md §8g) — so the console must not surface the bot's own accounts
   * (or a synthetic system sender like "system") as rate-limited "users". Seeding + the
   * grouped console view drop any user partition that isn't a real user identity or is one
   * of these.
   */
  selfUserIds?: ReadonlySet<string>;
  now?: () => number;
  /** Fraction at which a meter is "near" its cap (console). Default 0.8. */
  nearThreshold?: number;
  /** Rolling-recompute / calendar-roll tick (default 60_000 ms). */
  tickMs?: number;
}

interface MeterState {
  spent: number;
  windowStart: number;
  resetsAt: number;
  window: WindowSpec;
  /**
   * The binding (least) cap of every constraint that maps to this meter (issue #2).
   * Stored at materialization from `ResolvedConstraint.cap` and folded with `Math.min`
   * each time another constraint touches the same meter, so `statuses()` reports the
   * cap DIRECTLY instead of reverse-deriving it from the rule set (which ignored the
   * partition/room/space dimensions and mis-reported a shared pool's cap). The
   * in-memory enforcement path never reads this — affordability uses
   * `ResolvedConstraint.cap` straight off the resolution.
   */
  cap: number;
  /** Ledger seed filter (window bounds added at seed/recompute). */
  seed: SeedFilter;
  /**
   * Structured key fields, stored verbatim (NOT re-parsed from `meterKey`) so the
   * console surface stays correct even when a literal partition or model id contains
   * the `#` key separator (issue #6). Populated once at materialization.
   */
  partitionKey: string;
  isUserPartition: boolean;
  modelScope?: string[];
  /**
   * Console ladder sort key — the PREFERENCE-order position of this cap (see
   * `ResolvedConstraint.orderKey`): single caps at their model's preference index, a
   * composite right after its last member. Folded with `Math.min` when constraints share
   * a meter, so the order is stable. NOT the authored constraint index, NOT fill %.
   */
  orderIndex: number;
}

/** Seed/recompute filter for one meter (the dimensions identifying its spend). */
interface SeedFilter {
  triggerSenderIds?: string[];
  partitionKeys?: string[];
  roomIds?: string[];
  spaceIds?: string[];
  requestedModelIds?: string[];
  /** Agent/account-scoped rule seeding (spec MULTI-AGENT-SUPPORT §8). */
  timelineKeyPrefixes?: string[];
}

/** A live session's currently-selected model, for the console (spec §14). */
export interface UserLimitSelection {
  /** The owning session — the stable per-selection key (two concurrent
   *  same-user/same-model sessions are distinct rows; console keys on this). */
  sessionId: string;
  userId: string;
  roomId?: string;
  /** The REQUESTED virtual model the per-user selector is currently dispatching. */
  model: string;
}

/** Per-binding-constraint status for the console (spec §14). */
export interface UserLimitStatus {
  meterKey: string;
  partitionKey: string;
  isUserPartition: boolean;
  modelScope?: string[];
  /** Preference-order sort key — the ladder order the console renders in (§14). */
  orderIndex: number;
  spentUsd: number;
  capUsd: number;
  fraction: number;
  state: "ok" | "near" | "blocked";
  window:
    | { type: "rolling"; duration: string }
    | { type: "calendar"; period: "day" | "week" | "month"; tz: string };
  resetsAt: number;
}

/** One partition's rollup for the paginated console surface (spec §14). */
export interface UserLimitGroup {
  partitionKey: string;
  isUserPartition: boolean;
  /** Worst state across the partition's meters (the sort key + header badge). */
  state: "ok" | "near" | "blocked";
  /** Peak fill fraction across the partition's meters (secondary sort key). */
  peakFraction: number;
  /** All the partition's meters — the console folds them into one ladder strip. */
  meters: UserLimitStatus[];
}

// ─── Glob + partition-template helpers ────────────────────────────────────────

/**
 * Anchored fnmatch (spec §8.1): `*` matches any run (incl. empty); case-sensitive;
 * every other char literal. Compiled per glob; the rule set is small + static.
 */
export function compileGlob(glob: string): (value: string) => boolean {
  // Escape every regex metachar EXCEPT `*`, then turn `*` into `.*`. Anchored.
  const body = glob.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`));
  const re = new RegExp(`^${body}$`);
  return (value: string) => re.test(value);
}

/** True when ANY glob in `globs` matches `value` (OR within a dimension, §8.1). */
function matchDimension(globs: string[] | undefined, value: string | undefined): boolean {
  if (!globs) return true; // omitted dimension = wildcard
  if (value === undefined) return false; // a present dimension can't match an absent value
  return globs.some((g) => compileGlob(g)(value));
}

/**
 * True when ANY glob matches ANY value (spec §11): the `space` dimension matches if
 * any of the room's parent spaces matches any rule glob (a room may belong to
 * several). OR within the dimension AND across the value list.
 */
function matchMultiDimension(globs: string[] | undefined, values: string[] | undefined): boolean {
  if (!globs) return true; // omitted dimension = wildcard
  if (!values || values.length === 0) return false;
  return globs.some((g) => {
    const re = compileGlob(g);
    return values.some((v) => re(v));
  });
}

/** The homeserver suffix of a Matrix user id (`@a:hs.org` → `hs.org`), else "". */
export function homeserverOf(userId: string): string {
  const i = userId.indexOf(":");
  return i >= 0 ? userId.slice(i + 1) : "";
}

/**
 * Resolve a single known partition variable against a ctx (empty when absent).
 *
 * Canonical names: `{user_id}`, `{channel_id}`, `{server_id}`, `{homeserver}`.
 * Aliases: `{room_id}` = `{channel_id}`; `{space_id}` = `{server_id}`.
 * `{homeserver}` is Matrix-only; non-Matrix providers resolve it to "".
 */
function resolvePartitionVar(key: string, ctx: UserLimitContext): string {
  switch (key) {
    case "user_id":
      return ctx.userId;
    case "room_id":
    case "channel_id":
      return ctx.roomId ?? "";
    case "homeserver":
      return homeserverOf(ctx.userId);
    case "space_id":
    case "server_id":
      // The canonical (best) parent space / server — first of the best-first list (§11).
      return ctx.spaceIds?.[0] ?? "";
    default:
      return "";
  }
}

/** All recognized partition variable names (canonical + aliases). */
const PARTITION_VAR_REGEX = /\{(user_id|room_id|channel_id|homeserver|space_id|server_id)\}/g;

/**
 * Render a partition template (spec §3.5/§10) against a ctx. Known vars:
 * `{user_id}` / `{channel_id}` (`{room_id}` alias) / `{homeserver}` /
 * `{server_id}` (`{space_id}` alias). `{channel_id}` and `{server_id}` are the
 * canonical cross-provider names; `{room_id}` and `{space_id}` remain valid aliases.
 */
export function renderPartition(template: string, ctx: UserLimitContext): string {
  return template.replace(PARTITION_VAR_REGEX, (_m, key: string) =>
    resolvePartitionVar(key, ctx),
  );
}

/**
 * Render a partition AND report whether any of its template variables resolved to
 * empty (no value in the ctx). An empty *variable* means the pool it would key has
 * no real identity — e.g. `space:{server_id}` on a channel with no server scope
 * renders to the bare prefix `"space:"`, which would otherwise pool every unrelated
 * server-less channel into one bucket (#17). The caller skips such a shared-pool
 * constraint entirely (mirroring how an empty space *match* skips the rule), rather
 * than inventing a degenerate shared meter. A pure-literal partition (no variables)
 * and `{user_id}` (always present) never report `emptyVar`.
 */
function renderPartitionChecked(
  template: string,
  ctx: UserLimitContext,
): { key: string; emptyVar: boolean } {
  let emptyVar = false;
  const key = template.replace(PARTITION_VAR_REGEX, (_m, varName: string) => {
    const value = resolvePartitionVar(varName, ctx);
    if (value === "") emptyVar = true;
    return value;
  });
  return { key, emptyVar };
}

function windowKey(w: WindowSpec): string {
  return w.type === "rolling" ? `r:${w.duration}` : `c:${w.period}:${w.tz}`;
}

// =============================================================================

export class UserLimitEngine {
  private readonly rules: NormalizedUserLimitRule[];
  private readonly meters = new Map<string, MeterState>();
  /** Live per-session currently-selected model (spec §14), keyed by session id. */
  private readonly activeModels = new Map<string, UserLimitSelection>();
  private readonly now: () => number;
  private readonly nearThreshold: number;
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  /**
   * True when any rule references space (a `space` match or a `{space_id}` / `{server_id}`
   * partition). `{server_id}` is the canonical Discord alias for `{space_id}`.
   */
  readonly usesSpace: boolean;
  /**
   * True when any rule references room (a `room` match or a `{room_id}` / `{channel_id}`
   * partition). `{channel_id}` is the canonical Discord alias for `{room_id}`.
   */
  readonly usesRoom: boolean;

  constructor(private readonly options: UserLimitEngineOptions) {
    this.rules = [...options.rules].sort((a, b) => a.order - b.order);
    this.now = options.now ?? Date.now;
    this.nearThreshold = Math.min(0.999, Math.max(0.001, options.nearThreshold ?? 0.8));
    this.tickMs = options.tickMs ?? 60_000;
    // Whether ANY rule needs the (costly) parent-space resolution at Gate A (§11) —
    // a `space` match dimension, or a `{space_id}` / `{server_id}` (Discord alias) partition.
    this.usesSpace = this.rules.some(
      (r) =>
        r.space !== undefined ||
        r.constraints.some(
          (c) => c.partition.includes("{space_id}") || c.partition.includes("{server_id}"),
        ),
    );
    // Whether ANY rule needs room-id resolution — a `room` match, or a `{room_id}` /
    // `{channel_id}` (Discord alias) partition.
    this.usesRoom = this.rules.some(
      (r) =>
        r.room !== undefined ||
        r.constraints.some(
          (c) => c.partition.includes("{room_id}") || c.partition.includes("{channel_id}"),
        ),
    );
  }

  /** True when any rule is configured (the feature is on). */
  get enabled(): boolean {
    return this.rules.length > 0;
  }

  start(): void {
    if (this.timer || this.rules.length === 0) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Re-materialize meters for spend already on the ledger this window (spec
   * PER-USER-LIMITS §14). Call ONCE at startup before {@link start}, mirroring how
   * {@link BudgetEngine} seeds its global rule meters in its constructor. Without it a
   * partition partially consumed before a restart reads $0 until the next live
   * gate/record for it lazily re-creates its meter (the restart-visibility gap).
   *
   * Meter keys depend on the runtime trigger sender / room / parent space, so they
   * can't be enumerated from config — we discover the identities that DID spend from
   * the ledger (`listUsageIdentities`) and replay each through the SAME
   * `resolve()`→`meterFor()` path the live gates use, so the meterKey/seed logic is
   * identical (no drift). `meterFor` sums each meter from the ledger, restoring its
   * true accumulated spend. Zero-spend meters are then pruned: a full replay would
   * materialize every sub-cap (incl. never-hit caps and cap-0 bans) at $0 for every
   * past spender, flooding the console. Seeding restores *consumed* budget after a
   * restart; a never-consumed cap has nothing to restore and the live path re-creates
   * it lazily (enforcement is unaffected — bans still gate at resolve, not from a meter).
   *
   * Coverage corner: only non-null `trigger_sender_id` identities are replayed, so a
   * shared pool whose window spend is EXCLUSIVELY autonomous (no human trigger, e.g.
   * proactive-only) is not pre-seeded; it re-materializes on the next human turn that
   * resolves it. Aggregate reply pools always carry human spend, so this rarely bites.
   */
  /**
   * True when `senderId` is a real user id the enabled chat providers recognize — one that
   * per-user limits actually govern — AND is NOT the agent's own account. Excludes synthetic
   * system senders (e.g. `"system"`) and the bot itself, whose spend rides lanes that skip
   * Gate A (ARCHITECTURE.md §8g), so they must never appear as rate-limited "users".
   * The shape test is delegated to the injected {@link UserLimitEngineOptions.isUserIdentity}
   * predicate, which is the authority for user-id shape across all enabled providers.
   */
  private isEnforceableUser(senderId: string): boolean {
    return this.options.isUserIdentity(senderId) && !this.options.selfUserIds?.has(senderId);
  }

  seedFromLedger(): void {
    const list = this.options.listUsageIdentities;
    if (!list || this.rules.length === 0) return;
    const now = this.now();
    // Widest lookback across every constraint's current window — an identity that only
    // spent inside a narrower window is still enumerated (it falls within the widest),
    // and each meter sums its OWN window, so narrower meters read correctly.
    let earliest: number | undefined;
    for (const rule of this.rules) {
      for (const c of rule.constraints) {
        const start = resolveWindow(c.window, now).start;
        if (earliest === undefined || start < earliest) earliest = start;
      }
    }
    if (earliest === undefined) return; // no constraints anywhere → nothing to seed
    const identities = list({
      since: earliest,
      includeRoom: this.usesRoom,
      includeSpace: this.usesSpace,
    });
    for (const id of identities) {
      // Never seed the bot itself or a sender the isUserIdentity predicate rejects (synthetic/system senders) — per-user limits don't
      // govern their spend (Gate A is skipped for those lanes), so materializing a meter
      // would surface a phantom "user" the console must not show.
      if (!this.isEnforceableUser(id.senderId)) continue;
      const ctx: UserLimitContext = {
        userId: id.senderId,
        roomId: id.roomId,
        spaceIds: id.spaceId ? [id.spaceId] : undefined,
      };
      for (const c of this.resolve(ctx).constraints) this.meterFor(c);
    }
    // Prune every zero-spend meter a full replay materializes (a spender who never used
    // a given sub-cap, plus cap-0 bans) — only consumed budget is worth pre-showing.
    for (const [key, state] of this.meters) {
      if (state.spent <= 0) this.meters.delete(key);
    }
  }

  // ─── Cascade resolution (§8.1) ──────────────────────────────────────────────

  /**
   * Resolve the per-field cascade for a trigger ctx (spec §8.1). Collect matching
   * rules in authored order; take the model-budget block from the FIRST that has
   * one (atomic — `models` + `limits` together) and the refusal message from the
   * FIRST that supplies one (independently). Returns a resolution even when no
   * rule matches (`matched=false`, inert).
   *
   * `timelineKey` — the session's timeline key (spec MULTI-AGENT-SUPPORT §8). When
   * supplied, rules with `timelineKeyPrefixes` that don't match are skipped — i.e.
   * an agent-scoped rule only applies to sessions running under that agent. When
   * absent (e.g. `seedFromLedger` seed pass, which has no per-identity timelineKey),
   * scoped rules are included so their meters are seeded; the meter's SeedFilter
   * carries `timelineKeyPrefixes` and correctly counts only matching events.
   */
  resolve(ctx: UserLimitContext, timelineKey?: string): UserLimitResolution {
    const matching = this.rules.filter(
      (r) =>
        matchDimension(r.user, ctx.userId) &&
        matchDimension(r.room, ctx.roomId) &&
        matchMultiDimension(r.space, ctx.spaceIds) &&
        // Agent/account scoping: if the rule has timelineKeyPrefixes and a timelineKey
        // was supplied, only include the rule when the key matches one of the prefixes.
        // When timelineKey is absent (seeding), all rules are included regardless.
        (!r.timelineKeyPrefixes ||
          !timelineKey ||
          r.timelineKeyPrefixes.some((p) => timelineKey.startsWith(`${p}:`))),
    );
    if (matching.length === 0) {
      return { matched: false, active: false, banned: false, constraints: [], ledgerPartitionKeys: [] };
    }
    const budgetRule = matching.find((r) => r.hasBudgetBlock);
    const messageTemplate = matching.find((r) => r.messageTemplate !== undefined)?.messageTemplate;

    if (!budgetRule) {
      // Matched only message-override rules → no budget block ⇒ inert budget, but
      // the message still cascades (used only if some OTHER gate refuses; here none).
      return {
        matched: true,
        active: false,
        banned: false,
        constraints: [],
        ledgerPartitionKeys: [],
        messageTemplate,
      };
    }

    const constraints: ResolvedConstraint[] = [];
    for (const c of budgetRule.constraints) {
      const resolved = this.resolveConstraint(budgetRule, c, ctx);
      // A shared-pool constraint whose partition variable resolved empty (e.g.
      // `space:{space_id}` on a space-less room) keys no real pool — skip it rather
      // than pooling unrelated events together (#17). The rule's fungible total and
      // any non-empty-partition constraint on the SAME rule still apply.
      if (resolved !== undefined) constraints.push(resolved);
    }
    // The DISTINCT shared-pool keys this session may denormalize (spec
    // MULTI-SHARED-POOL §4) — model-blind superset; per-event narrowing is
    // `sharedPoolKeys`. Order-preserving dedupe so the FIRST (scalar fast-path) key is
    // stable across events of the same session.
    const ledgerPartitionKeys = [
      ...new Set(constraints.filter((c) => !c.isUserPartition).map((c) => c.partitionKey)),
    ];
    const banned =
      budgetRule.models?.length === 0 ||
      constraints.some((c) => c.modelScope === undefined && c.cap === 0);
    const active = budgetRule.models !== undefined || constraints.length > 0;
    return {
      matched: true,
      active,
      banned,
      models: budgetRule.models,
      constraints,
      ledgerPartitionKeys,
      messageTemplate,
    };
  }

  /**
   * The DISTINCT shared-pool keys a single committed event actually joins (spec
   * MULTI-SHARED-POOL §4) — the model-AWARE narrowing of `resolution.ledgerPartitionKeys`
   * the recorder stamps onto the ledger. Coverage mirrors {@link record} EXACTLY: a
   * model-agnostic shared pool (`modelScope === undefined`) is always joined; a
   * model-scoped shared sub-cap is joined only when `coverageModelId` is in its scope.
   * `coverageModelId` is the REQUESTED model for an agent-loop event and `undefined`
   * for the tool lane (which never joins a model-scoped sub-cap, issue #14). Order
   * follows constraint order so the first key is the stable scalar fast-path member.
   */
  sharedPoolKeys(resolution: UserLimitResolution, coverageModelId: string | undefined): string[] {
    const keys: string[] = [];
    for (const c of resolution.constraints) {
      if (c.isUserPartition) continue;
      if (c.modelScope !== undefined) {
        if (coverageModelId === undefined || !c.modelScope.includes(coverageModelId)) continue;
      }
      if (!keys.includes(c.partitionKey)) keys.push(c.partitionKey);
    }
    return keys;
  }

  private resolveConstraint(
    rule: NormalizedUserLimitRule,
    c: NormalizedConstraint,
    ctx: UserLimitContext,
  ): ResolvedConstraint | undefined {
    const { key: partitionKey, emptyVar } = renderPartitionChecked(c.partition, ctx);
    const isUserPartition = !c.shared;
    // A shared pool whose partition template has an unresolved/empty variable keys no
    // meaningful meter (#17) — signal "skip" so unrelated events aren't pooled. The
    // per-user `{user_id}` partition is never shared, so an empty here is only ever a
    // shared template (`space:{space_id}` etc.); a pure-literal partition has no vars.
    if (c.shared && emptyVar) return undefined;
    // A room/space-matched rule narrows every meter to the trigger's room / canonical
    // parent space (sturdy seed via the room_id / space_id column, §16 Q2 / §11) — so
    // a per-user or pool counter on a scoped rule counts only that room's/space's spend.
    const roomScope = rule.room ? ctx.roomId : undefined;
    const spaceScope = rule.space ? ctx.spaceIds?.[0] : undefined;
    const modelScope = c.models ? [...c.models].sort() : undefined;
    // Preference-order sort key for the console ladder (§14): order caps by the rule's
    // `models` preference list. A single-model cap → its model's preference index; a
    // composite (≥2 models) → the MAX preference index of its members (so it lands right
    // after the last model it's built from), then memberCount so a single precedes a
    // composite at the same rung (e.g. sol, terra, sol+terra, glm). A fungible total
    // (no scope) sorts first. Falls back to the authored index if the rule lists no models.
    const prefIndex = (m: string): number => {
      const i = rule.models?.indexOf(m) ?? -1;
      return i < 0 ? (rule.models?.length ?? 0) : i; // unknown model → after all known
    };
    const orderKey = rule.models
      ? modelScope && modelScope.length > 0
        ? Math.max(...modelScope.map(prefIndex)) * 1000 + modelScope.length
        : -1000
      : c.index;
    // Carry agent/account scope from the rule to the constraint (§8 attribution).
    const timelineKeyPrefixes = rule.timelineKeyPrefixes;
    // Unambiguous meter identity (#6): JSON-encode the structured tuple rather than
    // `#`-join it, so a literal partition or model id that itself contains `#` can
    // never collide two distinct meters or split one. The key is OPAQUE — the console
    // reads structured fields off `MeterState`, never by splitting the key — so the
    // encoding is free to change.
    // Include `timelineKeyPrefixes` so a scoped rule (e.g. agent="alice") and a global
    // rule with otherwise identical dimensions get DISTINCT meters — they count different
    // subsets of events and must not share a counter.
    const meterKey = JSON.stringify([
      isUserPartition ? "u" : "p",
      partitionKey,
      modelScope ?? null,
      windowKey(c.window),
      roomScope ?? null,
      spaceScope ?? null,
      timelineKeyPrefixes ?? null,
    ]);
    return {
      meterKey,
      cap: c.maxUsd,
      window: c.window,
      modelScope,
      partitionKey,
      isUserPartition,
      roomScope,
      spaceScope,
      source: { ruleOrder: rule.order, index: c.index },
      orderKey,
      timelineKeyPrefixes,
    };
  }

  // ─── Meter materialization + window math ────────────────────────────────────

  private seedFilterFor(c: ResolvedConstraint): SeedFilter {
    const seed: SeedFilter = {};
    if (c.isUserPartition) seed.triggerSenderIds = [c.partitionKey];
    else seed.partitionKeys = [c.partitionKey];
    if (c.roomScope) seed.roomIds = [c.roomScope];
    if (c.spaceScope) seed.spaceIds = [c.spaceScope];
    if (c.modelScope) seed.requestedModelIds = c.modelScope;
    if (c.timelineKeyPrefixes) seed.timelineKeyPrefixes = c.timelineKeyPrefixes;
    return seed;
  }

  private meterFor(c: ResolvedConstraint): MeterState {
    const existing = this.meters.get(c.meterKey);
    if (existing) {
      this.rollIfNeeded(existing);
      // Two constraints that share a meterKey share one counter; the binding (least)
      // cap governs the badge (#2). Fold it on each touch so the order of first access
      // doesn't matter. The ladder order likewise folds to the least (earliest-authored)
      // index for a stable console position.
      existing.cap = Math.min(existing.cap, c.cap);
      existing.orderIndex = Math.min(existing.orderIndex, c.orderKey);
      return existing;
    }
    const now = this.now();
    const w = resolveWindow(c.window, now);
    const seed = this.seedFilterFor(c);
    const state: MeterState = {
      spent: this.options.sumUsageCost({ since: w.start, ...seed }),
      windowStart: w.start,
      resetsAt: w.resetsAt,
      window: c.window,
      cap: c.cap,
      seed,
      partitionKey: c.partitionKey,
      isUserPartition: c.isUserPartition,
      modelScope: c.modelScope,
      orderIndex: c.orderKey,
    };
    this.meters.set(c.meterKey, state);
    return state;
  }

  /** Roll a passed CALENDAR boundary in place (no SUM) — mirrors BudgetEngine. */
  private rollIfNeeded(state: MeterState): void {
    if (state.window.type !== "calendar") return;
    const now = this.now();
    if (now < state.resetsAt) return;
    const w = resolveWindow(state.window, now);
    state.windowStart = w.start;
    state.resetsAt = w.resetsAt;
    state.spent = 0;
  }

  /** Authoritative periodic reconcile — rolling re-SUM + calendar roll-with-reseed. */
  private tick(): void {
    const now = this.now();
    for (const state of this.meters.values()) {
      const w = resolveWindow(state.window, now);
      if (state.window.type === "rolling") {
        state.windowStart = w.start;
        state.resetsAt = w.resetsAt;
        state.spent = this.options.sumUsageCost({ since: w.start, ...state.seed });
      } else if (w.start !== state.windowStart) {
        state.windowStart = w.start;
        state.resetsAt = w.resetsAt;
        state.spent = this.options.sumUsageCost({ since: w.start, ...state.seed });
      }
    }
  }

  // ─── Affordability estimate (§5.3) ─────────────────────────────────────────

  /**
   * Can the REQUESTED model `requestedModelId` complete a turn for this resolution
   * within remaining budget right now (spec §5.3, predicate 1)? Prices the prior
   * context at the model's uncached input rate (conservative — never under-charges),
   * caps output at the headroom, and reports UNAFFORDABLE when that cap can't buy a
   * `viable_min` turn. A zero-cost model (or no covering constraint) is always
   * affordable. The `min` ranges over EVERY covering constraint — per-user and
   * shared-pool alike (§8.2).
   *
   * `thinkingBudgetTokens` (#4) is the extended-thinking output the provider will
   * BILL on top of the issued base `max_tokens` (additive Anthropic/Gemini paths;
   * 0 for adaptive-thinking models, the OpenAI effort path, and thinking-off). The
   * budgeted (and viable-min) basis is the TOTAL billed output (text + thinking), but
   * the returned `maxOutput` is the BASE cap to issue, so that after the provider adds
   * the thinking budget the wire cap — and thus the billed output — stays within the
   * authorized headroom. Default 0 → today's behavior.
   */
  affordable(
    resolution: UserLimitResolution,
    requestedModelId: string,
    estimate: AffordabilityEstimate,
    thinkingBudgetTokens = 0,
  ): AffordabilityResult {
    const modelDefaultMax = this.options.maxTokensFor(requestedModelId);
    // Zero-cost bypass (§5.3): a free model can never move or be blocked.
    if (this.options.zeroCostModelIds.has(requestedModelId)) {
      return { ok: true, maxOutput: modelDefaultMax ?? this.options.viableMinOutputTokens, remainingUsd: Infinity };
    }
    const covering = resolution.constraints.filter(
      (c) => c.modelScope === undefined || c.modelScope.includes(requestedModelId),
    );
    if (covering.length === 0) {
      // Unconstrained (exempt / pure upgrade) → always affordable.
      return { ok: true, maxOutput: modelDefaultMax ?? this.options.viableMinOutputTokens, remainingUsd: Infinity };
    }
    let remaining = Infinity;
    let binding: ResolvedConstraint | undefined;
    for (const c of covering) {
      const meter = this.meterFor(c);
      const headroom = c.cap - meter.spent;
      if (headroom < remaining) {
        remaining = headroom;
        binding = c;
      }
    }
    const rates = this.options.costRatesFor(requestedModelId);
    // No rates known at all (shouldn't happen for a configured model) → treat as free
    // to avoid wrongly denying; the §8e/§8d gates still bound such a model elsewhere.
    // (A genuinely free model is caught earlier by the zeroCostModelIds bypass.)
    if (!rates) {
      const ok = remaining > 0;
      return {
        ok,
        maxOutput: ok ? modelDefaultMax ?? this.options.viableMinOutputTokens : 0,
        binding,
        remainingUsd: remaining,
      };
    }
    // Input cost with the prompt-cache model (§5.3): within the cache TTL the prior
    // prompt is a cache-read hit and only the new material is cache-write; otherwise
    // the whole input is priced at cache-write (conservative). A model without cache
    // rates falls back to the plain input rate for both, so this degrades to
    // `tokens × input_price` for non-caching models. Computed BEFORE the output-rate
    // branch so an output-free / input-paid model is still charged for its input (#8).
    const cached = estimate.cachedTokens ?? 0;
    const fresh = estimate.newTokens ?? 0;
    const readRate = (rates.cacheReadPerMTok ?? 0) > 0 ? rates.cacheReadPerMTok! : rates.inputPerMTok;
    const writeRate = (rates.cacheWritePerMTok ?? 0) > 0 ? rates.cacheWritePerMTok! : rates.inputPerMTok;
    const inputCost = estimate.withinCacheTtl
      ? (cached / 1_000_000) * readRate + (fresh / 1_000_000) * writeRate
      : ((cached + fresh) / 1_000_000) * writeRate;
    // Output genuinely free (zero/absent output price, but input may be priced): the
    // output cap can stay at the model default, but the request is still UNAFFORDABLE
    // when the input alone exceeds the remaining headroom (#8 — previously this branch
    // ignored inputCost and could admit an input-paid model over budget).
    if (rates.outputPerMTok <= 0) {
      const ok = remaining - inputCost > 0;
      return {
        ok,
        maxOutput: ok ? modelDefaultMax ?? this.options.viableMinOutputTokens : 0,
        binding,
        remainingUsd: remaining,
      };
    }
    const outputPricePerToken = rates.outputPerMTok / 1_000_000;
    // The remaining headroom must pay for the TOTAL billed output — base text PLUS the
    // additive thinking budget the provider bills on top (#4) — so the affordable
    // total is priced at the output rate over both. The issued base cap then RESERVES
    // the thinking budget inside it: `base = affordableOutput − thinkingBudget`, so the
    // provider's `min(base + thinkingBudget, modelMax)` wire cap never exceeds what the
    // budget bought. The viable-min predicate is applied to the base (text) portion —
    // a turn whose budget is entirely consumed by thinking cannot complete.
    const thinking = Math.max(0, thinkingBudgetTokens);
    const affordableOutput = Math.floor((remaining - inputCost) / outputPricePerToken);
    const affordableBase = affordableOutput - thinking;
    if (!(affordableBase > this.options.viableMinOutputTokens)) {
      return { ok: false, maxOutput: Math.max(0, affordableBase), binding, remainingUsd: remaining };
    }
    const maxOutput = Math.min(modelDefaultMax ?? affordableBase, affordableBase);
    return { ok: true, maxOutput, binding, remainingUsd: remaining };
  }

  /**
   * Remaining headroom (USD) of the binding FUNGIBLE-TOTAL constraint(s) — the
   * dynamic §8d ceiling input (spec §6.3). The min over covering totals (no
   * `models` scope); undefined when the user has no total constraint (exempt /
   * pure upgrade) ⇒ ∞ headroom (no change to the static ceiling).
   */
  totalHeadroom(resolution: UserLimitResolution): number | undefined {
    const totals = resolution.constraints.filter((c) => c.modelScope === undefined);
    if (totals.length === 0) return undefined;
    let min = Infinity;
    for (const c of totals) {
      const meter = this.meterFor(c);
      min = Math.min(min, Math.max(0, c.cap - meter.spent));
    }
    return Number.isFinite(min) ? min : undefined;
  }

  // ─── Recording (§8.2) ───────────────────────────────────────────────────────

  /**
   * Record one committed event against a session's FROZEN resolution (spec §8.2).
   * Increments every meter whose model scope COVERS the spend by the ACTUAL served
   * cost. One event thus updates several meters. No-op for a non-positive cost or an
   * inactive resolution.
   *
   * Coverage depends on the event's lane:
   *  - **Agent loop** — pass the REQUESTED model (the gate-on-virtual identity of
   *    §7). Covers the fungible total, any shared pool, AND every sub-cap whose
   *    `models` scope includes the requested model (per-user + pool sub-caps).
   *  - **Tool lane** — pass `undefined`. Tool spend has no requested model and must
   *    NOT touch a model-scoped sub-cap: a sub-cap reserves *agent-loop degradation*
   *    headroom, so charging it for tool spend that happens to share the model name
   *    (e.g. `x_search`→Grok when a session sub-caps Grok) is an over-restriction
   *    footgun (issue #14). So a tool event credits ONLY the model-agnostic
   *    constraints (fungible total + shared pools, `modelScope === undefined`) —
   *    still drawing down the user's total and any pool, never a sub-cap. The ledger
   *    reseed mirrors this (see `usageCostClauses`' agent-loop-gated null-fallback).
   *    Tracking/attribution is unaffected: the ledger row keeps the tool's
   *    `model_id`/`logical_model_id` for §8e aggregates and console top-models.
   */
  record(
    resolution: UserLimitResolution,
    requestedModelId: string | undefined,
    costUsd: number,
  ): void {
    if (!(costUsd > 0)) return;
    for (const c of resolution.constraints) {
      if (c.modelScope !== undefined) {
        // Sub-cap: tool spend (no requested model) never counts toward it; an
        // agent-loop event counts only when the requested model is in scope.
        if (requestedModelId === undefined || !c.modelScope.includes(requestedModelId)) continue;
      }
      this.meterFor(c).spent += costUsd;
    }
  }

  // ─── Refusal-message support (§12) ─────────────────────────────────────────

  /**
   * The binding constraint for a refusal: the covering constraint with the least
   * headroom for `requestedModelId` (or, when omitted, across the whole resolution
   * — the soonest-resetting over-cap one). Used to populate the message tokens.
   */
  bindingConstraint(
    resolution: UserLimitResolution,
    requestedModelId?: string,
  ): ResolvedConstraint | undefined {
    const covering = resolution.constraints.filter(
      (c) =>
        requestedModelId === undefined ||
        c.modelScope === undefined ||
        c.modelScope.includes(requestedModelId),
    );
    let binding: ResolvedConstraint | undefined;
    let minHeadroom = Infinity;
    for (const c of covering) {
      const headroom = c.cap - this.meterFor(c).spent;
      if (headroom < minHeadroom) {
        minHeadroom = headroom;
        binding = c;
      }
    }
    return binding;
  }

  /**
   * The binding constraint to report in a REFUSAL message (spec §12): when several
   * windows are exhausted, the user is unblocked the moment the SOONEST-resetting
   * binding constraint resets, so the message's `{resets_at}`/`{resets_in}` must
   * quote that one — NOT the least-headroom one (a different question, served by
   * `bindingConstraint`). Among constraints at/over cap (`spent >= cap`) pick the
   * smallest `accurateResetsAt`; a cap-0 ban has no reset (`accurateResetsAt`
   * undefined) and sorts last so a resetting window is preferred when present. Fall
   * back to least-headroom only when nothing is strictly over cap (e.g. admitted
   * elsewhere / numerically tied), preserving the old behaviour in that case.
   */
  refusalBindingConstraint(resolution: UserLimitResolution): ResolvedConstraint | undefined {
    let binding: ResolvedConstraint | undefined;
    let minResetsAt = Infinity;
    for (const c of resolution.constraints) {
      if (this.meterFor(c).spent < c.cap) continue; // only over/at-cap windows bind a refusal
      const resetsAt = this.accurateResetsAt(c) ?? Infinity;
      if (resetsAt < minResetsAt) {
        minResetsAt = resetsAt;
        binding = c;
      }
    }
    // None strictly over cap (or all cap-0 bans): keep least-headroom selection.
    return binding ?? this.bindingConstraint(resolution);
  }

  /**
   * Accurate reset instant for a resolved constraint's current window (§12 / §5 #5):
   * the fixed boundary for calendar; `min(contributing ts) + duration` for rolling
   * (off the hot path). Returns undefined for a cap-0 ban (no meaningful reset).
   */
  accurateResetsAt(c: ResolvedConstraint): number | undefined {
    if (c.cap === 0) return undefined;
    const meter = this.meterFor(c);
    if (c.window.type !== "rolling") return meter.resetsAt;
    const minTs = this.options.minUsageTs?.({ since: meter.windowStart, ...meter.seed });
    if (minTs === undefined || minTs === null) return this.now() + c.window.durationMs;
    return minTs + c.window.durationMs;
  }

  // ─── Live selection registry (§14) ─────────────────────────────────────────

  /** Record a live session's currently-selected model (spec §14, console surface). */
  noteSelection(sessionId: string, userId: string, roomId: string | undefined, model: string): void {
    this.activeModels.set(sessionId, { sessionId, userId, roomId, model });
  }

  /** Drop a settled session's selection (called on settle). */
  clearSelection(sessionId: string): void {
    this.activeModels.delete(sessionId);
  }

  /** The currently-selected model of every live per-user session (spec §14). */
  activeSelections(): UserLimitSelection[] {
    return [...this.activeModels.values()];
  }

  // ─── Console statuses (§14) ────────────────────────────────────────────────

  /** One status per currently-materialized meter (spec §14). */
  statuses(): UserLimitStatus[] {
    const out: UserLimitStatus[] = [];
    for (const [meterKey, state] of this.meters) {
      this.rollIfNeeded(state);
      // Read the structured key fields off the meter (NOT re-split from `meterKey`),
      // so a literal partition / model id containing `#` reports correctly (#6). The
      // cap is the binding (least) cap stored at materialization (#2) — never
      // reverse-derived from the rule set, which ignored partition/room/space and
      // mis-reported a shared pool's cap.
      const cap = state.cap;
      const fraction = cap > 0 ? state.spent / cap : state.spent > 0 ? Infinity : 1;
      const blocked = state.spent >= cap && cap >= 0;
      const near = !blocked && fraction >= this.nearThreshold;
      const w = state.window;
      out.push({
        meterKey,
        partitionKey: state.partitionKey,
        isUserPartition: state.isUserPartition,
        modelScope: state.modelScope,
        orderIndex: state.orderIndex,
        spentUsd: state.spent,
        capUsd: cap,
        fraction: Number.isFinite(fraction) ? fraction : 1,
        state: blocked ? "blocked" : near ? "near" : "ok",
        window:
          w.type === "rolling"
            ? { type: "rolling", duration: w.duration }
            : { type: "calendar", period: w.period, tz: w.tz },
        resetsAt: state.resetsAt,
      });
    }
    return out;
  }

  /**
   * Every materialized meter grouped by partition and sorted hottest-first, split into
   * `individuals` (per-user partitions) and `shared` pools (spec §14). The console
   * paginates each side SERVER-side (`/api/usage/user-limits`) so the view scales to any
   * number of users — the whole meter set never ships at once. The group sort MIRRORS
   * the console's `buildLadder` group order (worst state, then peak fill, then key), so
   * a server page is a contiguous top-slice under the same order the client renders in.
   */
  groupedStatuses(): { individuals: UserLimitGroup[]; shared: UserLimitGroup[] } {
    const RANK = { blocked: 0, near: 1, ok: 2 } as const;
    const groups = new Map<string, UserLimitGroup>();
    for (const s of this.statuses()) {
      // Defensively drop non-human user partitions (bot / system) even if one ever
      // materialized at runtime — seeding already skips them (see isEnforceableUser).
      if (s.isUserPartition && !this.isEnforceableUser(s.partitionKey)) continue;
      const gk = `${s.isUserPartition ? "u" : "p"} ${s.partitionKey}`;
      let g = groups.get(gk);
      if (!g) {
        g = {
          partitionKey: s.partitionKey,
          isUserPartition: s.isUserPartition,
          state: "ok",
          peakFraction: 0,
          meters: [],
        };
        groups.set(gk, g);
      }
      g.meters.push(s);
      if (RANK[s.state] < RANK[g.state]) g.state = s.state;
      if (s.fraction > g.peakFraction) g.peakFraction = s.fraction;
    }
    const hot = (a: UserLimitGroup, b: UserLimitGroup): number =>
      RANK[a.state] - RANK[b.state] ||
      b.peakFraction - a.peakFraction ||
      a.partitionKey.localeCompare(b.partitionKey);
    const all = [...groups.values()];
    return {
      individuals: all.filter((g) => g.isUserPartition).sort(hot),
      shared: all.filter((g) => !g.isUserPartition).sort(hot),
    };
  }
}
