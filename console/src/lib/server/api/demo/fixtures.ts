/**
 * Demo-mode fixtures (spec CONSOLE-DEMO-MODE). Curated, non-sensitive fake data
 * that renders the real console UI without a live agent. Everything is invented —
 * synthetic Matrix ids on `matrix.example.org`, invented display names, invented
 * chat — so the public project stays deployment-agnostic and no real usernames or
 * conversations can leak into a screenshot.
 *
 * Values are computed against the real wall clock at request time (this runs on
 * the BFF server, in Node), so the spend chart fills the recent window and every
 * "resets in" / "last seen" reads as live rather than frozen.
 *
 * `resolveFixture(pathname, params)` returns an `unknown` value for a matched GET
 * path; the demo AgentApiClient layer decodes it through the caller's Effect Schema
 * (the same fidelity guard the live client uses), so a fixture that drifts from the
 * wire shape fails exactly like a real backend drift would.
 */

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const round = (x: number, dp: number): number => {
	const f = 10 ** dp;
	return Math.round(x * f) / f;
};
const usd = (x: number): number => round(x, 4);

// ── Invented actors, rooms, models ──────────────────────────────────────────

const SERVER = 'matrix.example.org';
const uid = (local: string): string => `@${local}:${SERVER}`;

interface DemoUser {
	id: string;
	name: string;
}
const USERS: DemoUser[] = [
	{ id: uid('ada'), name: 'Ada' },
	{ id: uid('grace'), name: 'Grace' },
	{ id: uid('linus'), name: 'Linus' },
	{ id: uid('katherine'), name: 'Katherine' },
	{ id: uid('radia'), name: 'Radia' },
	{ id: uid('margaret'), name: 'Margaret' },
	{ id: uid('alan'), name: 'Alan' },
	{ id: uid('barbara'), name: 'Barbara' }
];

interface DemoRoom {
	key: string;
	name: string;
	space: string;
}
const ROOMS: DemoRoom[] = [
	{ key: `!general:${SERVER}`, name: 'general', space: 'Sample Server' },
	{ key: `!art-share:${SERVER}`, name: 'art-share', space: 'Sample Server' },
	{ key: `!off-topic:${SERVER}`, name: 'off-topic', space: 'Sample Server' },
	{ key: `!tech-help:${SERVER}`, name: 'tech-help', space: 'Sample Server' },
	{ key: `dm:${uid('ada')}`, name: 'Ada', space: 'DM' }
];
const roomLabel = (r: DemoRoom): string => `${r.name} (${r.space})`;

const MODEL_AGENT = 'anthropic/claude-sonnet-4';
const MODEL_FAST = 'anthropic/claude-haiku-4';
const MODEL_CAPTION = 'google/gemini-2.5-flash';
const MODEL_EMBED = 'voyage/voyage-3.5';

const CLASSES = ['agent_loop', 'tool', 'caption', 'embedding'] as const;
type SpendClass = (typeof CLASSES)[number];

// Per-class → model attribution (fractions sum to 1 within each class).
const MODEL_SPLIT: Record<SpendClass, { model: string; frac: number }[]> = {
	agent_loop: [
		{ model: MODEL_AGENT, frac: 0.82 },
		{ model: MODEL_FAST, frac: 0.18 }
	],
	tool: [{ model: MODEL_FAST, frac: 1 }],
	caption: [{ model: MODEL_CAPTION, frac: 1 }],
	embedding: [{ model: MODEL_EMBED, frac: 1 }]
};

const CLASS_PEAK: Record<SpendClass, number> = {
	agent_loop: 0.22,
	tool: 0.075,
	caption: 0.028,
	embedding: 0.009
};
// Per-class jitter seed so stacked segments vary independently within a bucket.
const CLASS_SEED: Record<SpendClass, number> = {
	agent_loop: 0.11,
	tool: 2.7,
	caption: 5.3,
	embedding: 8.9
};

// Community-chat rhythm anchored to real clock time: quiet overnight, a midday
// bump, a big evening peak. Indexed by hour-of-day for sub-day buckets.
const HOUR_PROFILE = [
	0.34, 0.27, 0.2, 0.16, 0.15, 0.17, 0.24, 0.4, 0.56, 0.63, 0.6, 0.67, 0.79, 0.71, 0.64,
	0.72, 0.83, 0.96, 1.16, 1.29, 1.19, 1.04, 0.77, 0.5
];
// Day-of-week rhythm (Sun..Sat) for day-bucketed windows — weekends run hotter.
const DOW_PROFILE = [1.02, 0.82, 0.86, 0.9, 0.93, 1.12, 1.24];

/** Deterministic hash in [0,1) — the jitter source (a stable stand-in for RNG). */
function hash(n: number): number {
	const x = Math.sin(n * 12.9898 + 1.37) * 43758.5453;
	return x - Math.floor(x);
}
const CLASS_EVENT_COST: Record<SpendClass, number> = {
	agent_loop: 0.018,
	tool: 0.0045,
	caption: 0.0021,
	embedding: 0.00018
};

// ── Spend model (drives summary, timeseries, leaderboard) ───────────────────

function windowCfg(window: string): { bucketMs: number; count: number } {
	switch (window) {
		case '7d':
			return { bucketMs: 6 * HOUR, count: 28 };
		case '30d':
		case 'month':
			return { bucketMs: DAY, count: 30 };
		case 'all':
			return { bucketMs: 7 * DAY, count: 16 };
		case 'today':
		case '24h':
		default:
			return { bucketMs: HOUR, count: 24 };
	}
}

function bucketsFor(now: number, bucketMs: number, count: number): number[] {
	const end = Math.floor(now / bucketMs) * bucketMs;
	return Array.from({ length: count }, (_, i) => end - (count - 1 - i) * bucketMs);
}

/**
 * Deterministic (no RNG) per-(bucket, class) cost. The shape is a real time-of-day /
 * day-of-week rhythm (anchored to the bucket's actual clock time) times per-class hash
 * jitter and the odd spike — irregular on purpose, so the chart never reads as a smooth
 * sine wave. No RNG, so the summary and timeseries requests of one render agree.
 */
function classCost(cls: SpendClass, bucket: number, bucketMs: number, i: number): number {
	const d = new Date(bucket);
	let rhythm: number;
	if (bucketMs < DAY) rhythm = HOUR_PROFILE[d.getHours()];
	else if (bucketMs < 7 * DAY) rhythm = DOW_PROFILE[d.getDay()];
	else rhythm = 0.68 + 0.5 * hash(i * 7.1);
	const spike = hash(i * 3.3 + 1.7) > 0.86 ? 1.55 : 1;
	const jitter = 0.6 + 0.8 * hash(i * 5.2 + CLASS_SEED[cls]);
	const scale = bucketMs / HOUR; // longer buckets accumulate proportionally more
	return usd(CLASS_PEAK[cls] * rhythm * spike * jitter * scale);
}

const eventsFor = (cls: SpendClass, cost: number): number =>
	Math.max(1, Math.round(cost / CLASS_EVENT_COST[cls]));

interface SpendModel {
	bucketMs: number;
	classSeries: { bucket: number; grp: string; cost: number }[];
	modelSeries: { bucket: number; grp: string; cost: number }[];
	classTotals: Map<string, { cost: number; events: number }>;
	modelTotals: Map<string, { cost: number; events: number }>;
	firstBucket: number;
	total: number;
}

function spendModel(window: string, now: number): SpendModel {
	const { bucketMs, count } = windowCfg(window);
	const buckets = bucketsFor(now, bucketMs, count);
	const classSeries: { bucket: number; grp: string; cost: number }[] = [];
	const modelSeries: { bucket: number; grp: string; cost: number }[] = [];
	const classTotals = new Map<string, { cost: number; events: number }>();
	const modelTotals = new Map<string, { cost: number; events: number }>();
	const bump = (m: Map<string, { cost: number; events: number }>, k: string, c: number, e: number) => {
		const cur = m.get(k) ?? { cost: 0, events: 0 };
		cur.cost = usd(cur.cost + c);
		cur.events += e;
		m.set(k, cur);
	};
	let total = 0;
	for (let i = 0; i < count; i++) {
		const bucket = buckets[i];
		for (const cls of CLASSES) {
			const cost = classCost(cls, bucket, bucketMs, i);
			if (cost <= 0) continue;
			total = usd(total + cost);
			classSeries.push({ bucket, grp: cls, cost });
			bump(classTotals, cls, cost, eventsFor(cls, cost));
			for (const { model, frac } of MODEL_SPLIT[cls]) {
				const mc = usd(cost * frac);
				if (mc <= 0) continue;
				modelSeries.push({ bucket, grp: model, cost: mc });
				bump(modelTotals, model, mc, eventsFor(cls, mc));
			}
		}
	}
	return {
		bucketMs,
		classSeries,
		modelSeries,
		classTotals,
		modelTotals,
		firstBucket: buckets[0],
		total
	};
}

// ── Usage & Cost endpoints ──────────────────────────────────────────────────

function usageSummary(window: string, now: number): unknown {
	const m = spendModel(window, now);
	return {
		since: m.firstBucket,
		now,
		firstTs: m.firstBucket + 3 * MIN,
		total: m.total,
		byClass: [...m.classTotals.entries()].map(([cls, v]) => ({
			class: cls,
			cost: v.cost,
			events: v.events
		})),
		byModel: [...m.modelTotals.entries()]
			.map(([model, v]) => ({ model, cost: v.cost, events: v.events }))
			.sort((a, b) => b.cost - a.cost)
	};
}

function usageTimeseries(window: string, groupBy: string, now: number): unknown {
	const m = spendModel(window, now);
	return {
		series: groupBy === 'model' ? m.modelSeries : m.classSeries,
		bucketMs: m.bucketMs,
		groupBy: groupBy === 'model' ? 'model' : 'class'
	};
}

// A curated set of recent sessions, reused by the usage table + the room lists.
interface DemoSession {
	id: string;
	roomIdx: number;
	userIdx: number | null; // null = system/self actor
	type: string;
	model: string;
	status: string;
	ageMin: number;
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	agentCost: number;
	toolCost: number;
	toolCalls: number;
	trigger: string;
}

const SESSIONS: DemoSession[] = [
	{ id: 'ses_op4kq2', roomIdx: 0, userIdx: 0, type: 'reply', model: MODEL_AGENT, status: 'completed', ageMin: 6, requests: 5, input: 4200, output: 980, cacheRead: 61200, cacheWrite: 8400, agentCost: 0.184, toolCost: 0.082, toolCalls: 3, trigger: 'Hey Miku, can you find where we talked about the summer meetup and make a poster for it?' },
	{ id: 'ses_7hy1nd', roomIdx: 1, userIdx: 4, type: 'reply', model: MODEL_AGENT, status: 'completed', ageMin: 19, requests: 3, input: 2600, output: 540, cacheRead: 40100, cacheWrite: 5200, agentCost: 0.102, toolCost: 0.041, toolCalls: 1, trigger: 'what anime is this screenshot from?' },
	{ id: 'ses_k2f8ra', roomIdx: 2, userIdx: 2, type: 'reply', model: MODEL_FAST, status: 'completed', ageMin: 34, requests: 2, input: 1800, output: 310, cacheRead: 22400, cacheWrite: 3100, agentCost: 0.028, toolCost: 0, toolCalls: 0, trigger: 'lol did you see the game last night' },
	{ id: 'ses_qq93mx', roomIdx: 0, userIdx: 1, type: 'reply', model: MODEL_AGENT, status: 'running', ageMin: 1, requests: 2, input: 3100, output: 220, cacheRead: 38900, cacheWrite: 6100, agentCost: 0.091, toolCost: 0.012, toolCalls: 1, trigger: 'can you summarize the thread about the new render pipeline?' },
	{ id: 'ses_zt0p5c', roomIdx: 3, userIdx: 3, type: 'reply', model: MODEL_AGENT, status: 'completed', ageMin: 52, requests: 4, input: 5200, output: 1240, cacheRead: 71000, cacheWrite: 9800, agentCost: 0.221, toolCost: 0.019, toolCalls: 2, trigger: 'my docker build keeps failing on the native module step, any idea?' },
	{ id: 'ses_v8n2ke', roomIdx: 4, userIdx: 0, type: 'reply', model: MODEL_AGENT, status: 'completed', ageMin: 74, requests: 6, input: 6100, output: 1600, cacheRead: 88200, cacheWrite: 11200, agentCost: 0.298, toolCost: 0.104, toolCalls: 4, trigger: 'remind me what we decided about the color palette' },
	{ id: 'ses_m3l7wq', roomIdx: 1, userIdx: 5, type: 'reply', model: MODEL_AGENT, status: 'failed-resumable', ageMin: 96, requests: 2, input: 2200, output: 90, cacheRead: 30100, cacheWrite: 4200, agentCost: 0.061, toolCost: 0, toolCalls: 0, trigger: 'can you redraw this in a chibi style?' },
	{ id: 'ses_bf6r8a', roomIdx: 2, userIdx: 6, type: 'reply', model: MODEL_FAST, status: 'completed', ageMin: 128, requests: 1, input: 1400, output: 180, cacheRead: 18800, cacheWrite: 2400, agentCost: 0.019, toolCost: 0, toolCalls: 0, trigger: 'good morning everyone' },
	{ id: 'ses_summ41', roomIdx: 0, userIdx: null, type: 'summarize', model: MODEL_FAST, status: 'completed', ageMin: 45, requests: 1, input: 12800, output: 640, cacheRead: 0, cacheWrite: 14200, agentCost: 0.047, toolCost: 0, toolCalls: 0, trigger: '(hierarchical summarization)' },
	{ id: 'ses_diary7', roomIdx: 4, userIdx: null, type: 'diary', model: MODEL_AGENT, status: 'completed', ageMin: 180, requests: 1, input: 9400, output: 820, cacheRead: 0, cacheWrite: 10600, agentCost: 0.079, toolCost: 0, toolCalls: 0, trigger: '(daily diary entry)' },
	{ id: 'ses_proac3', roomIdx: 2, userIdx: null, type: 'proactive', model: MODEL_AGENT, status: 'completed', ageMin: 210, requests: 2, input: 3600, output: 410, cacheRead: 42000, cacheWrite: 5400, agentCost: 0.118, toolCost: 0.028, toolCalls: 1, trigger: '(proactive posting)' },
	{ id: 'ses_x1c9tp', roomIdx: 3, userIdx: 7, type: 'reply', model: MODEL_AGENT, status: 'completed', ageMin: 265, requests: 3, input: 3300, output: 720, cacheRead: 47700, cacheWrite: 6300, agentCost: 0.134, toolCost: 0.006, toolCalls: 1, trigger: 'whats the difference between FTS5 and vector search again' }
];

const sessionTs = (s: DemoSession, now: number) => now - s.ageMin * MIN;

function usageSessionsFixture(now: number): unknown {
	return {
		sessions: SESSIONS.map((s) => {
			const room = ROOMS[s.roomIdx];
			return {
				sessionId: s.id,
				modelId: s.model,
				sessionType: s.type,
				timelineKey: room.key,
				channelLabel: roomLabel(room),
				triggerSender: s.userIdx == null ? null : USERS[s.userIdx].id,
				status: s.status,
				completedAt: s.status === 'running' ? null : sessionTs(s, now),
				requests: s.requests,
				inputTokens: s.input,
				outputTokens: s.output,
				cacheReadTokens: s.cacheRead,
				cacheWriteTokens: s.cacheWrite,
				agentCost: s.agentCost,
				toolCost: s.toolCost,
				toolCalls: s.toolCalls
			};
		})
	};
}

function usageToolCallsFixture(now: number): unknown {
	// Recent paid tool / caption / embedding events.
	const rows: unknown[] = [];
	const push = (
		i: number,
		cls: string,
		tool: string | null,
		model: string,
		provider: string | null,
		room: DemoRoom | null,
		userIdx: number | null,
		sessId: string | null,
		fields: Partial<{ input: number; output: number; cr: number; images: number }>,
		cost: number,
		ref: string | null
	) => {
		rows.push({
			id: `evt_${i.toString().padStart(4, '0')}`,
			ts: now - i * 7 * MIN - 2 * MIN,
			class: cls,
			agent_session_id: sessId,
			session_type: sessId ? 'reply' : null,
			timeline_key: room?.key ?? null,
			trigger_sender_id: userIdx == null ? null : USERS[userIdx].id,
			tool_name: tool,
			model_id: model,
			provider,
			input_tokens: fields.input ?? null,
			output_tokens: fields.output ?? null,
			cache_read_tokens: fields.cr ?? null,
			cache_write_tokens: null,
			images: fields.images ?? null,
			cost_usd: usd(cost),
			ref,
			channel_label: room ? roomLabel(room) : null
		});
	};
	push(1, 'tool', 'image_generate', 'openai/gpt-image-1', 'openai', ROOMS[0], 0, 'ses_op4kq2', { images: 1 }, 0.042, 'att_9f2a');
	push(2, 'tool', 'image_generate', 'openai/gpt-image-1', 'openai', ROOMS[0], 0, 'ses_op4kq2', { images: 1 }, 0.04, 'att_9f2b');
	push(3, 'caption', null, MODEL_CAPTION, 'google', ROOMS[1], null, null, { input: 1120, output: 88 }, 0.0021, 'att_71cd');
	push(4, 'tool', 'find_source', MODEL_FAST, 'anthropic', ROOMS[1], 4, 'ses_7hy1nd', { input: 900, output: 140 }, 0.011, null);
	push(5, 'caption', null, MODEL_CAPTION, 'google', ROOMS[3], null, null, { input: 1340, output: 96 }, 0.0024, 'att_44a1');
	push(6, 'embedding', null, MODEL_EMBED, 'voyage', ROOMS[0], null, null, { input: 8200 }, 0.00082, 'chunk_512');
	push(7, 'tool', 'image_generate', 'openai/gpt-image-1', 'openai', ROOMS[4], 0, 'ses_v8n2ke', { images: 1 }, 0.041, 'att_1b7e');
	push(8, 'embedding', null, MODEL_EMBED, 'voyage', ROOMS[2], null, null, { input: 6400 }, 0.00064, 'chunk_513');
	push(9, 'tool', 'search_history', MODEL_FAST, 'anthropic', ROOMS[3], 3, 'ses_zt0p5c', { input: 1200, output: 210 }, 0.014, null);
	push(10, 'caption', null, MODEL_CAPTION, 'google', ROOMS[1], null, null, { input: 1080, output: 74 }, 0.002, 'att_c30f');
	return { toolCalls: rows };
}

function usageLeaderboardFixture(window: string, now: number): unknown {
	const { bucketMs, count } = windowCfg(window);
	const buckets = bucketsFor(now, bucketMs, count);
	// Descending per-user totals (invented but plausible), scaled to the window.
	const scale = (bucketMs / HOUR) * (count / 24);
	const baseTotals = [3.42, 2.18, 1.74, 1.31, 0.96, 0.63, 0.44, 0.21];
	const series = (total: number, phase: number) => {
		const raw = buckets.map((b, i) => ({
			bucket: b,
			w: 0.3 + hash(i * 4.1 + phase * 7)
		}));
		const sum = raw.reduce((s, r) => s + r.w, 0) || 1;
		return raw.map((r) => ({ bucket: r.bucket, cost: usd((r.w / sum) * total) }));
	};
	const users = USERS.map((u, i) => {
		const total = usd(baseTotals[i] * scale);
		return {
			senderId: u.id,
			displayName: u.name,
			kind: 'user',
			rank: i + 1,
			total,
			events: Math.max(1, Math.round(total / 0.02)),
			sessions: Math.max(1, Math.round(total / 0.12)),
			firstTs: buckets[0] + 2 * MIN,
			lastTs: now - (i + 1) * 4 * MIN,
			series: series(total, i * 0.5)
		};
	});
	const humanTotal = users.reduce((s, u) => s + u.total, 0);
	const sorted = [...users.map((u) => u.total)].sort((a, b) => a - b);
	const median = sorted.length
		? sorted.length % 2
			? sorted[(sorted.length - 1) / 2]
			: (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
		: 0;
	const systemActors = [
		{ label: 'Summarization', phase: 0.3, total: 0.86, cmp: 6 },
		{ label: 'Diary', phase: 1.1, total: 0.62, cmp: 6 },
		{ label: 'Proactive', phase: 2.0, total: 1.12, cmp: 4 }
	].map((a) => {
		const total = usd(a.total * scale);
		return {
			senderId: a.label,
			displayName: a.label,
			kind: 'system',
			comparisonRank: a.cmp,
			total,
			events: Math.max(1, Math.round(total / 0.05)),
			sessions: Math.max(1, Math.round(total / 0.08)),
			firstTs: buckets[0] + 2 * MIN,
			lastTs: now - 12 * MIN,
			series: series(total, a.phase)
		};
	});
	const grandTotal = usd(humanTotal + systemActors.reduce((s, a) => s + a.total, 0) + 0.4 * scale);
	return {
		now,
		bucketMs,
		grandTotal,
		userStats: {
			count: users.length,
			average: usd(humanTotal / users.length),
			median: usd(median)
		},
		users,
		systemActors
	};
}

function calendarWindow(period: string, tz: string) {
	return { type: 'calendar', period, tz };
}
function rollingWindow(duration: string) {
	return { type: 'rolling', duration };
}

function usageBudgetsFixture(now: number): unknown {
	const rules = [
		{
			name: 'daily-total',
			spentUsd: 6.83,
			capUsd: 25,
			fraction: 6.83 / 25,
			state: 'ok',
			window: calendarWindow('day', 'UTC'),
			resetsAt: now + 9 * HOUR + 12 * MIN,
			scope: { classes: ['agent_loop', 'tool', 'caption', 'embedding'] }
		},
		{
			name: 'hourly-burst',
			spentUsd: 0.91,
			capUsd: 1.0,
			fraction: 0.91,
			state: 'near',
			window: rollingWindow('1h'),
			resetsAt: now + 21 * MIN,
			scope: { classes: ['agent_loop'] }
		},
		{
			name: 'image-gen-daily',
			spentUsd: 2.0,
			capUsd: 2.0,
			fraction: 1.0,
			state: 'blocked',
			window: calendarWindow('day', 'UTC'),
			resetsAt: now + 9 * HOUR + 12 * MIN,
			scope: { tools: ['image_generate'] }
		},
		{
			name: 'premium-models',
			spentUsd: 18.4,
			capUsd: 60,
			fraction: 18.4 / 60,
			state: 'ok',
			window: rollingWindow('7d'),
			resetsAt: now + 4 * DAY + 3 * HOUR,
			scope: { models: [MODEL_AGENT, 'anthropic/claude-opus-4'] },
			components: [
				{ model: MODEL_AGENT, spentUsd: 13.7 },
				{ model: 'anthropic/claude-opus-4', spentUsd: 4.7 }
			]
		},
		{
			name: 'monthly-ceiling',
			spentUsd: 112.6,
			capUsd: 400,
			fraction: 112.6 / 400,
			state: 'ok',
			window: calendarWindow('month', 'UTC'),
			resetsAt: now + 12 * DAY,
			scope: {}
		},
		{
			name: 'embeddings-off',
			spentUsd: 0,
			capUsd: 0,
			fraction: 1,
			state: 'blocked',
			window: rollingWindow('24h'),
			resetsAt: now + 6 * HOUR,
			scope: { classes: ['embedding'] }
		}
	];
	const userSelections = [
		{ sessionId: 'ses_qq93mx', userId: USERS[1].id, roomId: ROOMS[0].key, model: MODEL_AGENT },
		{ sessionId: 'ses_op4kq2', userId: USERS[0].id, roomId: ROOMS[0].key, model: MODEL_AGENT },
		{ sessionId: 'ses_k2f8ra', userId: USERS[2].id, roomId: ROOMS[2].key, model: MODEL_FAST }
	];
	return { rules, userSelections };
}

function userLimitsFixture(scope: string, page: number, now: number): unknown {
	const pageSize = 20;
	const day = calendarWindow('day', 'UTC');
	const resetsAt = now + 9 * HOUR + 12 * MIN;
	const meter = (
		partitionKey: string,
		isUser: boolean,
		suffix: string,
		spentUsd: number,
		capUsd: number,
		orderIndex: number,
		modelScope?: string[]
	) => {
		const fraction = capUsd > 0 ? spentUsd / capUsd : 1;
		const state = fraction >= 1 ? 'blocked' : fraction >= 0.8 ? 'near' : 'ok';
		return {
			meterKey: `${partitionKey}:${suffix}`,
			partitionKey,
			isUserPartition: isUser,
			modelScope,
			orderIndex,
			spentUsd: usd(spentUsd),
			capUsd,
			fraction,
			state,
			window: day,
			resetsAt
		};
	};

	if (scope === 'shared') {
		const meters = [
			meter('guests', false, 'all', 1.62, 3.0, 0),
			meter('trusted', false, 'all', 4.1, 10.0, 0)
		];
		return { scope: 'shared', page, pageSize, meters, totals: { individuals: 6, shared: 2 } };
	}

	// individuals: mix of single-cap users, a near/blocked one, and one composite.
	const meters = [
		meter(USERS[0].id, true, 'all', 1.94, 2.5, 0),
		meter(USERS[1].id, true, 'all', 2.38, 2.5, 0),
		// composite user: two single-model caps + a combined cap over both.
		meter(USERS[2].id, true, MODEL_AGENT, 0.72, 1.5, 0, [MODEL_AGENT]),
		meter(USERS[2].id, true, MODEL_FAST, 0.31, 1.0, 1, [MODEL_FAST]),
		meter(USERS[2].id, true, 'combined', 1.03, 2.0, 2, [MODEL_AGENT, MODEL_FAST]),
		meter(USERS[3].id, true, 'all', 2.5, 2.5, 0),
		meter(USERS[4].id, true, 'all', 0.58, 2.5, 0),
		meter(USERS[5].id, true, 'all', 0.22, 2.5, 0)
	];
	return { scope: 'individuals', page, pageSize, meters, totals: { individuals: 6, shared: 2 } };
}

// ── Observability endpoints ─────────────────────────────────────────────────

function roomsFixture(now: number): unknown {
	const sessionCounts = [42, 27, 61, 18, 9];
	const eventCounts = [3120, 1840, 5210, 940, 260];
	return {
		rooms: ROOMS.map((r, i) => ({
			timelineKey: r.key,
			displayName: roomLabel(r),
			timelineState: 'joined',
			lastActivityAt: now - (i * 11 + 3) * MIN,
			eventCount: eventCounts[i],
			sessionCount: sessionCounts[i]
		}))
	};
}

/** SessionMeta list-shape row for a demo session. */
function sessionMeta(s: DemoSession, now: number): unknown {
	const room = ROOMS[s.roomIdx];
	const ts = sessionTs(s, now);
	return {
		id: s.id,
		timelineKey: room.key,
		sessionType: s.type,
		status: s.status,
		modelId: s.model,
		triggerEventId: `$evt_${s.id}`,
		triggerExternalId: null,
		triggerBody: s.trigger,
		tokenEstimate: s.cacheRead + s.input + 1800,
		llmRequests: s.requests,
		usage: {
			input: s.input,
			output: s.output,
			cacheRead: s.cacheRead,
			cacheWrite: s.cacheWrite,
			cost: usd(s.agentCost)
		},
		contextTokens: s.cacheRead + s.input,
		maxContextTokens: 200000,
		maxSessionCostUsd: 2.0,
		noReply: false,
		error: s.status === 'failed-resumable' ? 'llm request failed after retries (429)' : null,
		createdAt: ts - 30_000,
		startedAt: ts - 28_000,
		updatedAt: s.status === 'running' ? now : ts,
		completedAt: s.status === 'running' ? null : ts
	};
}

function roomSessionsFixture(key: string, now: number): unknown {
	const idx = ROOMS.findIndex((r) => r.key === key);
	const roomIdx = idx >= 0 ? idx : 0;
	return {
		sessions: SESSIONS.filter((s) => s.roomIdx === roomIdx).map((s) => sessionMeta(s, now))
	};
}

function roomFacetsFixture(key: string): unknown {
	const idx = ROOMS.findIndex((r) => r.key === key);
	const roomIdx = idx >= 0 ? idx : 0;
	const types = [...new Set(SESSIONS.filter((s) => s.roomIdx === roomIdx).map((s) => s.type))];
	return { types: types.length ? types : ['reply'] };
}

const SYSTEM_PROMPT =
	'You are Miku, a warm and curious member of this chat community. You have a persistent ' +
	'memory, can search past conversations, caption images, and generate art. Stay in character, ' +
	'be concise, and only reply when you have something worth adding. [persona and tool guidance ' +
	'continue for several thousand more tokens…]';

function roomContextFixture(key: string): unknown {
	return {
		timelineKey: key,
		preview: false,
		syntheticTriggerEventId: null,
		messages: [
			{
				type: 'system',
				role: 'system',
				content: SYSTEM_PROMPT,
				tier: 'system',
				tokenEstimate: 2410,
				timestamp: null
			},
			{
				type: 'summary',
				role: 'user',
				content:
					'[Summary of earlier conversation] The channel spent the afternoon planning a ' +
					'summer meetup — date tentatively the third weekend of August, venue TBD. Ada offered ' +
					'to design a poster; Grace shared reference art.',
				tier: 'summary',
				tokenEstimate: 640,
				timestamp: null
			}
		],
		tokenEstimate: 3050,
		compactTokens: 640,
		richTokens: 2410,
		cacheBoundaries: []
	};
}

// The featured, fully-detailed session for the observability screenshot.
const FEATURED_ID = 'ses_op4kq2';

function sessionDetailFixture(id: string, now: number): unknown {
	const base = SESSIONS.find((s) => s.id === id) ?? SESSIONS[0];
	const meta = sessionMeta({ ...base, id }, now) as Record<string, unknown>;
	// Give the featured session its richer auxiliary tool-spend lane.
	meta.toolUsage = {
		calls: 2,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost: usd(base.toolCost)
	};

	const usage = (totalTokens: number, output: number, cost: number) => ({
		input: 4200,
		output,
		cacheRead: 61200,
		cacheWrite: 0,
		totalTokens,
		cost: { total: usd(cost) }
	});

	const contextSnapshot = [
		{
			type: 'system',
			role: 'system',
			content: SYSTEM_PROMPT,
			tier: 'system',
			tokenEstimate: 2410,
			timestamp: null
		},
		{
			type: 'summary',
			role: 'user',
			content:
				'[Summary of earlier conversation] The channel discussed a summer meetup earlier — ' +
				'tentatively the third weekend of August. Ada offered to make a poster.',
			tier: 'summary',
			tokenEstimate: 640,
			timestamp: null
		}
	];

	const transcript = [
		// [0] head trigger turn (verbatim input view; rolloutStartIndex = 1)
		{
			type: 'triggerGroup',
			role: 'user',
			content: [
				{
					type: 'text',
					text: 'Hey Miku, can you find where we talked about the summer meetup and make a poster for it?'
				}
			],
			tier: 'trigger',
			tokenEstimate: 24,
			timestamp: now - 6 * MIN
		},
		// rollout begins
		{
			role: 'assistant',
			content: [
				{
					type: 'thinking',
					thinking:
						'They want two things: the earlier meetup discussion, and a poster. Let me search ' +
						'the channel history first so I get the date and venue right, then generate the art.'
				},
				{ type: 'text', text: 'On it! Let me dig up what we said about the meetup first.' }
			],
			usage: usage(68200, 210, 0.184)
		},
		{
			role: 'assistant',
			content: [
				{
					type: 'toolCall',
					id: 'call_search_1',
					name: 'search_history',
					arguments: { query: 'summer meetup date venue', room: `!general:${SERVER}`, limit: 5 }
				}
			]
		},
		{
			role: 'toolResult',
			toolCallId: 'call_search_1',
			toolName: 'search_history',
			content: [
				{
					type: 'text',
					text:
						'3 matches:\n• Ada: "let\'s aim for the third weekend of August"\n• Grace: "the ' +
						'community hall on Elm St can hold ~40"\n• Linus: "start 2pm, potluck style"'
				}
			],
			isError: false
		},
		{
			role: 'assistant',
			content: [
				{
					type: 'text',
					text: 'Got it — third weekend of August, community hall on Elm St, 2pm potluck. Making the poster now.'
				}
			],
			usage: usage(69400, 320, 0.021)
		},
		{
			role: 'assistant',
			content: [
				{
					type: 'toolCall',
					id: 'call_img_1',
					name: 'image_generate',
					arguments: {
						prompt:
							'cheerful summer meetup poster, community picnic, warm pastel palette, hand-lettered ' +
							'"August Meetup — Elm St Hall, 2pm", cute flat illustration',
						size: '1024x1536'
					}
				}
			]
		},
		{
			role: 'toolResult',
			toolCallId: 'call_img_1',
			toolName: 'image_generate',
			content: [{ type: 'text', text: 'Generated 1 image (att_9f2a, 1024x1536, image/png).' }],
			isError: false
		},
		// user interjects mid-run
		{
			type: 'interjection',
			content: 'oh actually can you make it landscape so it fits the pinned message?'
		},
		{
			role: 'assistant',
			content: [
				{ type: 'text', text: 'Good call — redoing it in landscape.' },
				{
					type: 'toolCall',
					id: 'call_img_2',
					name: 'image_generate',
					arguments: {
						prompt:
							'cheerful summer meetup poster, landscape orientation, community picnic, warm pastel ' +
							'palette, hand-lettered "August Meetup — Elm St Hall, 2pm"',
						size: '1536x1024'
					}
				}
			],
			usage: usage(70100, 180, 0.019)
		},
		{
			role: 'toolResult',
			toolCallId: 'call_img_2',
			toolName: 'image_generate',
			content: [{ type: 'text', text: 'Generated 1 image (att_9f2b, 1536x1024, image/png).' }],
			isError: false
		},
		{
			role: 'assistant',
			content: [
				{
					type: 'text',
					text:
						'Here\'s the landscape version! 🎨 Summer Meetup — third weekend of August, Elm St ' +
						'community hall, 2pm, potluck style. Want me to pin it?'
				}
			],
			usage: usage(70900, 260, 0.024)
		}
	];

	const toolInvocations = [
		{
			id: 'ti_img_1',
			toolCallId: 'call_img_1',
			toolName: 'image_generate',
			modelId: 'openai/gpt-image-1',
			provider: 'openai',
			input: 320,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			images: 1,
			cost: 0.042,
			ref: 'att_9f2a',
			createdAt: now - 4 * MIN
		},
		{
			id: 'ti_img_2',
			toolCallId: 'call_img_2',
			toolName: 'image_generate',
			modelId: 'openai/gpt-image-1',
			provider: 'openai',
			input: 340,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			images: 1,
			cost: 0.04,
			ref: 'att_9f2b',
			createdAt: now - 3 * MIN
		}
	];

	return {
		session: meta,
		contextSnapshot,
		transcript,
		rolloutStartIndex: 1,
		contextDumpPath: null,
		toolInvocations
	};
}

// ── Pipeline monitor endpoints ──────────────────────────────────────────────

const CAPTION_MODEL = 'google/gemini-3.5-flash';

/** The four background pools + counts (ARCHITECTURE.md §11). Healthy, like a settled bot. */
function pipelinesFixture(): unknown {
	return {
		pipelines: [
			{
				pool: 'enrichment',
				enabled: true,
				workerCount: 4,
				maxRetries: 3,
				inFlight: 0,
				counts: { pending: 0, processing: 0, retrying: 0, done: 95436, failed: 0, skipped: 214, deferred: 0 },
				usage: null
			},
			{
				pool: 'captioning',
				enabled: true,
				workerCount: 2,
				maxRetries: 2,
				inFlight: 0,
				// `deferred` = pending assets the pool won't claim under the current config.
				counts: { pending: 0, processing: 0, retrying: 0, done: 275, failed: 0, skipped: 0, deferred: 6148 },
				usage: {
					captionedCount: 267,
					totalInputTokens: 309000,
					totalOutputTokens: 176000,
					totalCost: 1.79
				}
			},
			{
				pool: 'summarization',
				enabled: true,
				workerCount: 1,
				maxRetries: 3,
				inFlight: 0,
				counts: { pending: 0, processing: 0, retrying: 0, done: 901, failed: 0, skipped: 0, deferred: 0 },
				usage: null
			},
			{
				pool: 'diary',
				enabled: true,
				workerCount: 1,
				maxRetries: 3,
				inFlight: 0,
				counts: { pending: 0, processing: 0, retrying: 0, done: 612, failed: 0, skipped: 8, deferred: 0 },
				usage: null
			}
		]
	};
}

// Curated captioning items. `scene` picks the demo media placeholder (media.ts) so the
// caption matches what the placeholder actually draws. `hero` is deep-linked in the shot.
interface CaptionItem {
	id: string;
	file: string;
	scene: string;
	roomIdx: number;
	ageMin: number;
	input: number;
	output: number;
	cost: number;
	caption: string;
}
const CAPTION_ITEMS: CaptionItem[] = [
	{ id: 'cap-meadow', file: 'sunset.jpg', scene: 'landscape', roomIdx: 1, ageMin: 22 * 60, input: 1124, output: 775, cost: 0.0086, caption: 'A landscape photo of rolling green hills beneath a warm sunset, the sun sitting low on the horizon and a couple of birds in the peach-and-lavender sky.' },
	{ id: 'cap-sticker', file: 'sticker.png', scene: 'character', roomIdx: 0, ageMin: 34 * 60, input: 980, output: 512, cost: 0.0067, caption: 'A cute cartoon mascot with teal twin-tails and a small smile on a soft pastel background — reads like a chat sticker.' },
	{ id: 'cap-thread', file: 'screenshot.png', scene: 'ui', roomIdx: 3, ageMin: 26 * 60, input: 1340, output: 690, cost: 0.0091, caption: 'A screenshot of a chat app: a short message thread with a teal header bar and a highlighted reply bubble at the bottom.' },
	{ id: 'cap-poster', file: 'poster.jpg', scene: 'poster', roomIdx: 2, ageMin: 44 * 60, input: 1210, output: 604, cost: 0.0079, caption: 'A promotional poster for a fictional sci-fi game — bold title text over a dark purple-and-blue background with glowing orbs.' },
	{ id: 'cap-swatch', file: 'art.png', scene: 'abstract', roomIdx: 1, ageMin: 51 * 60, input: 890, output: 430, cost: 0.0058, caption: 'A colourful abstract graphic: overlapping translucent circles in blue, pink and violet on a soft gradient.' },
	{ id: 'cap-field', file: 'IMG_2048.jpeg', scene: 'landscape', roomIdx: 4, ageMin: 73 * 60, input: 1180, output: 742, cost: 0.0083, caption: 'An outdoor photo of a grassy field under a golden evening sky, layered hills fading into the distance.' },
	{ id: 'cap-react', file: 'meme.png', scene: 'character', roomIdx: 0, ageMin: 96 * 60, input: 1015, output: 560, cost: 0.0071, caption: 'A reaction sticker of a teal-haired mascot making a cheerful expression on a pastel gradient.' },
	{ id: 'cap-window', file: 'diagram.png', scene: 'ui', roomIdx: 3, ageMin: 128 * 60, input: 1265, output: 648, cost: 0.0085, caption: 'A screenshot of a simple app window with a header bar and a few lines of placeholder text.' }
];

/** The featured captioning item the demo pipelines screenshot should deep-link to. */
export const DEMO_FEATURED_CAPTION_ITEM = CAPTION_ITEMS[0].id;

function captionRef(it: CaptionItem): string {
	return `att-${it.scene}-${it.id}`;
}

/** One captioning `PipelineItem` (shared by the list + the detail header). */
function captionItem(it: CaptionItem, now: number): Record<string, unknown> {
	const room = ROOMS[it.roomIdx];
	const ts = now - it.ageMin * MIN;
	return {
		pool: 'captioning',
		id: it.id,
		status: 'complete',
		attempts: 1,
		maxRetries: 2,
		retrying: false,
		room: `matrix:miku:room:${room.key}`,
		createdAt: ts - 4000,
		updatedAt: ts,
		inputSummary: `${it.file} · image`,
		outputSummary: it.caption,
		error: null,
		sessionId: null
	};
}

function pipelineItemsFixture(pool: string, status: string | null, now: number): unknown {
	if (pool !== 'captioning') return { items: [], nextCursor: null };
	const items = CAPTION_ITEMS.filter((_) => status == null || status === 'complete').map((it) =>
		captionItem(it, now)
	);
	return { items, nextCursor: null };
}

function pipelineItemDetailFixture(pool: string, id: string, now: number): unknown | undefined {
	if (pool !== 'captioning') return undefined;
	const it = CAPTION_ITEMS.find((c) => c.id === id) ?? CAPTION_ITEMS[0];
	return {
		pool: 'captioning',
		item: captionItem(it, now),
		media: {
			ref: captionRef(it),
			role: 'source',
			mediaType: 'image',
			mimeType: it.file.endsWith('.png') ? 'image/png' : 'image/jpeg',
			filename: it.file,
			downloadStatus: 'complete',
			captionStatus: 'complete',
			caption: it.caption,
			captionModel: CAPTION_MODEL,
			hasBytes: true,
			usage: {
				input: it.input,
				output: it.output,
				cacheRead: 0,
				total: it.input + it.output,
				cost: it.cost
			}
		}
	};
}

/** GET /api/cost-overview — the three spend lanes, side by side. */
function costOverviewFixture(): unknown {
	return { agentLoopCost: 128.4, toolCost: 6.2, captioningCost: 1.79 };
}

// ── Routing ─────────────────────────────────────────────────────────────────

/** The featured session id the demo observability screenshot should deep-link to. */
export const DEMO_FEATURED_SESSION = FEATURED_ID;
/** A representative room key (for `?room=` in the observability deep-link). */
export const DEMO_FEATURED_ROOM = ROOMS[0].key;

/**
 * Resolve a GET request to an `unknown` fixture value, or `undefined` if the path
 * is not part of demo mode (the caller then 404s, matching the live client).
 */
export function resolveFixture(pathname: string, params: URLSearchParams): unknown | undefined {
	const now = Date.now();
	const window = params.get('window') ?? '24h';
	const groupBy = params.get('groupBy') ?? 'class';
	const scope = params.get('scope') ?? 'individuals';
	const page = Number(params.get('page') ?? '0') || 0;

	switch (pathname) {
		case '/api/usage/summary':
			return usageSummary(window, now);
		case '/api/usage/timeseries':
			return usageTimeseries(window, groupBy, now);
		case '/api/usage/sessions':
			return usageSessionsFixture(now);
		case '/api/usage/tool-calls':
			return usageToolCallsFixture(now);
		case '/api/usage/leaderboard':
			return usageLeaderboardFixture(window, now);
		case '/api/usage/budgets':
			return usageBudgetsFixture(now);
		case '/api/usage/user-limits':
			return userLimitsFixture(scope, page, now);
		case '/api/rooms':
			return roomsFixture(now);
		case '/api/pipelines':
			return pipelinesFixture();
		case '/api/cost-overview':
			return costOverviewFixture();
	}

	const status = params.get('status');
	let m: RegExpMatchArray | null;
	if ((m = pathname.match(/^\/api\/rooms\/([^/]+)\/sessions$/)))
		return roomSessionsFixture(decodeURIComponent(m[1]), now);
	if ((m = pathname.match(/^\/api\/rooms\/([^/]+)\/session-facets$/)))
		return roomFacetsFixture(decodeURIComponent(m[1]));
	if ((m = pathname.match(/^\/api\/rooms\/([^/]+)\/context$/)))
		return roomContextFixture(decodeURIComponent(m[1]));
	if ((m = pathname.match(/^\/api\/sessions\/([^/]+)$/)))
		return sessionDetailFixture(decodeURIComponent(m[1]), now);
	if ((m = pathname.match(/^\/api\/pipelines\/([^/]+)\/items\/([^/]+)$/)))
		return pipelineItemDetailFixture(m[1], decodeURIComponent(m[2]), now);
	if ((m = pathname.match(/^\/api\/pipelines\/([^/]+)\/items$/)))
		return pipelineItemsFixture(m[1], status, now);

	return undefined;
}

/**
 * Resolve a POST (mutation) to a canned success response. Demo mode is read-only;
 * the admin buttons never fire during a screenshot, but a canned response keeps the
 * decode path honest if one is clicked. `undefined` → 404.
 */
export function resolveMutation(pathname: string): unknown | undefined {
	let m: RegExpMatchArray | null;
	if ((m = pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/)))
		return { sessionId: decodeURIComponent(m[1]), status: 'interrupted' };
	if ((m = pathname.match(/^\/api\/sessions\/([^/]+)\/resume$/)))
		return { sessionId: decodeURIComponent(m[1]), status: 'completed' };
	if ((m = pathname.match(/^\/api\/pipelines\/([^/]+)\/items\/([^/]+)\/retry$/)))
		return { pool: m[1], id: decodeURIComponent(m[2]), status: 'pending' };
	if ((m = pathname.match(/^\/api\/pipelines\/([^/]+)\/retry-failed$/)))
		return { pool: m[1], retried: 0 };
	return undefined;
}
