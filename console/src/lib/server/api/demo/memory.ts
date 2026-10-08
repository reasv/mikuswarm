/**
 * Demo-mode fixtures for judged memory retrieval (spec MEMORY-RETRIEVAL §7.4, §9):
 * one retrieval build with its `memory` decision rows for the featured session,
 * the filters audit and the follow-up stats. Everything is invented: diary paths,
 * rooms, names, filter keys and text. Shapes follow the agent's writers
 * (src/retrieval/auto/types.ts `RetrievalReport`, src/decisions/points/memory.ts
 * `describe`, src/storage/memory-retrieval-store.ts readers).
 */

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const DEMO_DG_MEMORY = 'dg-memory-demo';

interface DemoPassage {
	hash: string;
	citation: string;
	path: string;
	lines: [number, number];
	lanes: string[];
	hybrid: number;
	late?: number | null;
	rerank?: number;
	relevant?: number;
	about?: number;
	presence: boolean;
	stage: string;
	hiddenBy?: { key: string; kind: string; detail?: string; probability?: number };
	/** Judged in this build: one decision row. */
	judged?: { keep: boolean; jokeFilter: number; text: string; date: string; room: string };
}

const hash = (n: number): string => `${n.toString(16).padStart(4, '0')}`.repeat(16);

const PASSAGES: DemoPassage[] = [
	{
		hash: hash(0xa101),
		citation: 'memory/2025-07-14.md:3-18 · general',
		path: 'memory/2025-07-14.md',
		lines: [3, 18],
		lanes: ['trigger', 'window'],
		hybrid: 0.712,
		late: 0.644,
		rerank: 0.821,
		relevant: 0.91,
		about: 0.4,
		presence: true,
		stage: 'kept',
		judged: {
			keep: true,
			jokeFilter: 0.04,
			date: '2025-07-14',
			room: 'general',
			text: 'Planned the summer meetup with Ada and Grace: third weekend of August, community hall, potluck.'
		}
	},
	{
		hash: hash(0xa102),
		citation: 'memory/2025-08-02.md:21-34 · general',
		path: 'memory/2025-08-02.md',
		lines: [21, 34],
		lanes: ['user_name', 'presence'],
		hybrid: 0.553,
		late: 0.581,
		rerank: 0.612,
		relevant: 0.78,
		about: 0.86,
		presence: true,
		stage: 'kept',
		judged: {
			keep: true,
			jokeFilter: 0.07,
			date: '2025-08-02',
			room: 'general',
			text: 'Ada asked for posters in a pastel palette; she prefers landscape layouts.'
		}
	},
	{
		hash: hash(0xa103),
		citation: 'memory/2025-06-30.md:40-52 · art-share',
		path: 'memory/2025-06-30.md',
		lines: [40, 52],
		lanes: ['window'],
		hybrid: 0.491,
		late: 0.472,
		rerank: 0.384,
		relevant: 0.12,
		about: 0.05,
		presence: false,
		stage: 'dropped',
		judged: {
			keep: false,
			jokeFilter: 0.11,
			date: '2025-06-30',
			room: 'art-share',
			text: 'Linus shared a pixel-art sprite sheet; talked about dithering.'
		}
	},
	{
		hash: hash(0xa104),
		citation: 'memory/2025-07-20.md:8-20 · off-topic',
		path: 'memory/2025-07-20.md',
		lines: [8, 20],
		lanes: ['trigger'],
		hybrid: 0.468,
		late: 0.455,
		rerank: 0.402,
		relevant: 0.66,
		about: 0.31,
		presence: true,
		stage: 'hidden',
		hiddenBy: { key: 'old_running_joke', kind: 'judged', probability: 0.93 },
		judged: {
			keep: true,
			jokeFilter: 0.93,
			date: '2025-07-20',
			room: 'off-topic',
			text: 'Kept the running joke about the meetup snacks going all evening.'
		}
	},
	{
		hash: hash(0xa105),
		citation: 'memory/2025-05-11.md:1-9 · general',
		path: 'memory/2025-05-11.md',
		lines: [1, 9],
		lanes: ['user_name'],
		hybrid: 0.442,
		presence: true,
		stage: 'hidden',
		hiddenBy: { key: 'old_nickname', kind: 'keyword', detail: 'captain' }
	},
	{
		hash: hash(0xa106),
		citation: 'memory/2025-08-19.md:1-15 · general',
		path: 'memory/2025-08-19.md',
		lines: [1, 15],
		lanes: ['window'],
		hybrid: 0.512,
		presence: false,
		stage: 'recency'
	},
	{
		hash: hash(0xa107),
		citation: 'memory/2025-04-02.md:30-41 · tech-help',
		path: 'memory/2025-04-02.md',
		lines: [30, 41],
		lanes: ['window'],
		hybrid: 0.412,
		late: 0.391,
		rerank: 0.081,
		presence: false,
		stage: 'cut_rerank'
	},
	{
		hash: hash(0xa108),
		citation: 'memory/2025-03-15.md:5-12 · tech-help',
		path: 'memory/2025-03-15.md',
		lines: [5, 12],
		lanes: ['trigger'],
		hybrid: 0.361,
		late: 0.214,
		presence: false,
		stage: 'cut_late'
	},
	{
		hash: hash(0xa109),
		citation: 'memory/2025-02-03.md:12-19 · general',
		path: 'memory/2025-02-03.md',
		lines: [12, 19],
		lanes: ['window'],
		hybrid: 0.333,
		late: null,
		presence: false,
		stage: 'not_selected'
	}
];

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function scores(p: DemoPassage): Record<string, number | null> {
	return { hybrid: r3(p.hybrid), late: p.late == null ? null : r3(p.late), rerank: p.rerank === undefined ? null : r3(p.rerank) };
}

function report(): unknown {
	return {
		source: 'model',
		candidates: PASSAGES.length,
		judged: PASSAGES.filter((p) => p.judged).length,
		kept: PASSAGES.filter((p) => p.stage === 'kept').length,
		hidden: PASSAGES.filter((p) => p.stage === 'hidden').length,
		tokens: 412,
		ms: 1380,
		decisionGroup: DEMO_DG_MEMORY,
		stages: {
			recallMs: 38,
			vectorIndex: 'primary',
			late: { status: 'ok', backend: 'onnx', ms: 96, windowSize: 200, missing: 0, queryModel: 'demo-late-encoder' },
			rerank: { status: 'ok', provider: 'local', ms: 142 },
			judgeMs: 1104
		},
		items: PASSAGES.map((p) => ({
			contentHash: p.hash,
			citation: p.citation,
			lanes: p.lanes,
			hybrid: r3(p.hybrid),
			...(p.late !== undefined ? { late: p.late === null ? null : r3(p.late) } : {}),
			...(p.rerank !== undefined ? { rerank: r3(p.rerank) } : {}),
			...(p.relevant !== undefined ? { relevant: p.relevant, aboutParticipant: p.about ?? null } : {}),
			presence: p.presence,
			stage: p.stage,
			...(p.hiddenBy ? { hiddenBy: p.hiddenBy } : {})
		}))
	};
}

const REQUEST = {
	from: 'Ada',
	text: 'Hey Miku, can you find where we talked about the summer meetup and make a poster for it?'
};

const QUESTIONS = JSON.stringify({
	relevant: {
		type: 'noul',
		instructions:
			'`entry` contains information that would help respond to `request` in this `conversation`: facts, history or earlier events about the people, things or topics being discussed.'
	},
	about_participant: { type: 'noul', instructions: '`entry` describes one of `participants` or an interaction with them.' },
	filter__old_running_joke: { type: 'noul', instructions: '`entry` matches: The entry is about the old running joke.' }
});

/** The featured session's `memory` decision rows: one per judged passage, one group. */
export function memoryDecisionRows(opts: { sessionId: string; timelineKey: string; ts: number; firstId: number }): unknown[] {
	const judged = PASSAGES.filter((p) => p.judged);
	return judged.map((p, i) => {
		const j = p.judged!;
		const hidden = j.jokeFilter >= 0.8;
		return {
			id: opts.firstId + i,
			ts: opts.ts + i * 3,
			decisionGroup: DEMO_DG_MEMORY,
			point: 'memory',
			agent: 'aria',
			timelineKey: opts.timelineKey,
			agentSessionId: opts.sessionId,
			triggerEventId: '$trigger:example.org',
			candidateSessionId: null,
			source: 'model',
			reason: null,
			verdictJson: JSON.stringify({
				citation: p.citation,
				contentHash: p.hash,
				keep: j.keep,
				relevant: p.relevant,
				aboutParticipant: p.about,
				...(hidden ? { hiddenBy: ['old_running_joke'] } : {}),
				scores: scores(p)
			}),
			answersJson: JSON.stringify({
				relevant: { type: 'noul', noul: p.relevant },
				about_participant: { type: 'noul', noul: p.about },
				filter__old_running_joke: { type: 'noul', noul: j.jokeFilter }
			}),
			stateJson: JSON.stringify({
				conversation: [{ from: 'Grace', text: 'Ada, did you ask Miku about the poster yet?' }],
				request: REQUEST,
				participants: ['Ada', 'Grace'],
				entry: { date: j.date, room: j.room, text: j.text }
			}),
			questionsJson: QUESTIONS,
			servedModel: 'demo/decision-model',
			servedVersion: 'v1',
			latencyMs: 980 + i * 41,
			inputTokens: 310 + i * 12,
			costUsd: 0.00012
		};
	});
}

/** GET /api/sessions/:id/memory-retrievals for the featured session. */
export function memoryRetrievalsFixture(opts: { sessionId: string; timelineKey: string; ts: number }): unknown {
	return {
		retrievals: [
			{
				id: 'mr-demo-1',
				agentSessionId: opts.sessionId,
				agent: 'aria',
				timelineKey: opts.timelineKey,
				ts: opts.ts,
				source: 'model',
				decisionGroup: DEMO_DG_MEMORY,
				candidates: PASSAGES.length,
				judged: PASSAGES.filter((p) => p.judged).length,
				kept: PASSAGES.filter((p) => p.stage === 'kept').length,
				hidden: PASSAGES.filter((p) => p.stage === 'hidden').length,
				tokens: 412,
				ms: 1380,
				reportJson: JSON.stringify(report()),
				followUpAt: opts.ts + 40 * SEC,
				followUpKind: 'recall_memory'
			}
		]
	};
}

/** A build that fell back (decision chain timed out): no decision rows, the leading card. */
export function fallbackRetrievalFixture(opts: { sessionId: string; timelineKey: string; ts: number }): unknown {
	const items = PASSAGES.slice(0, 3).map((p, i) => ({
		contentHash: p.hash,
		citation: p.citation,
		lanes: p.lanes,
		hybrid: r3(p.hybrid),
		presence: p.presence,
		stage: i === 0 ? 'kept' : 'not_judged'
	}));
	return {
		retrievals: [
			{
				id: 'mr-demo-2',
				agentSessionId: opts.sessionId,
				agent: 'aria',
				timelineKey: opts.timelineKey,
				ts: opts.ts,
				source: 'fallback',
				decisionGroup: null,
				candidates: 3,
				judged: 0,
				kept: 1,
				hidden: 0,
				tokens: 120,
				ms: 3020,
				reportJson: JSON.stringify({
					source: 'fallback',
					reason: 'timeout',
					candidates: 3,
					judged: 0,
					kept: 1,
					hidden: 0,
					tokens: 120,
					ms: 3020,
					stages: { recallMs: 41, judgeMs: 3000 },
					items
				}),
				followUpAt: null,
				followUpKind: null
			}
		]
	};
}

/** GET /api/memory/filter-hits */
export function memoryFilterHitsFixture(now: number): unknown {
	const hit = (
		filterKey: string,
		kind: string,
		p: DemoPassage,
		o: { detail?: string; probability?: number; surface: string; first: number; last: number; count: number }
	) => ({
		agent: 'aria',
		contentHash: p.hash,
		filterKey,
		filterHash: `${filterKey}-v1`,
		kind,
		detail: o.detail ?? null,
		probability: o.probability ?? null,
		path: p.path,
		startLine: p.lines[0],
		endLine: p.lines[1],
		surface: o.surface,
		firstHiddenAt: now - o.first,
		lastHiddenAt: now - o.last,
		hideCount: o.count
	});
	const [p1, p2, , p4, p5, p6, p7] = PASSAGES as [DemoPassage, DemoPassage, DemoPassage, DemoPassage, DemoPassage, DemoPassage, DemoPassage];
	const hits = [
		hit('old_running_joke', 'judged', p4, { probability: 0.93, surface: 'auto_retrieval', first: 3 * DAY, last: 6 * MIN, count: 5 }),
		hit('old_running_joke', 'judged', p6, { probability: 0.88, surface: 'recency_layer', first: 2 * DAY, last: 2 * HOUR, count: 14 }),
		hit('old_running_joke', 'judged', p7, { probability: 0.81, surface: 'recall_memory', first: 20 * HOUR, last: 20 * HOUR, count: 1 }),
		hit('old_nickname', 'keyword', p5, { detail: 'captain', surface: 'auto_retrieval', first: 9 * DAY, last: 6 * MIN, count: 7 }),
		hit('old_nickname', 'keyword', p2, { detail: 'cap', surface: 'search_memory', first: 4 * DAY, last: 4 * DAY, count: 1 }),
		hit('old_bit', 'pattern', p1, { detail: '(?i)\\bthe\\s+usual\\s+bit\\b', surface: 'diary_writer', first: 6 * DAY, last: 1 * DAY, count: 3 })
	];
	return { hits: hits.sort((a, b) => b.lastHiddenAt - a.lastHiddenAt) };
}

/** GET /api/memory/stats */
export function memoryStatsFixture(now: number): unknown {
	return {
		windows: [
			{
				days: 7,
				sinceTs: now - 7 * DAY,
				sessionsWithBlock: 184,
				followedUp: 23,
				rate: 23 / 184,
				builds: 412,
				sources: { model: 371, fallback: 12, unjudged: 4, none: 25 }
			},
			{
				days: 30,
				sinceTs: now - 30 * DAY,
				sessionsWithBlock: 690,
				followedUp: 71,
				rate: 71 / 690,
				builds: 1530,
				sources: { model: 1322, fallback: 61, unjudged: 19, none: 128 }
			}
		]
	};
}
