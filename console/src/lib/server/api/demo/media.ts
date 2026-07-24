/**
 * Demo-mode media placeholders (spec CONSOLE-DEMO-MODE). The `/api/media/:ref` proxy
 * streams real image bytes from the agent; in demo mode there is no agent and, more to
 * the point, no real user media may appear in a screenshot. So this synthesizes an
 * original, self-contained SVG per ref — clearly a placeholder, never a real photo.
 *
 * The scene is encoded in the ref (`att-<scene>-<n>`), so a fixture's caption can match
 * what the placeholder actually draws. Unknown refs fall back to an abstract tile.
 */

function wrap(inner: string): string {
	return `<svg viewBox="0 0 480 360" xmlns="http://www.w3.org/2000/svg" role="img">${inner}</svg>`;
}

function landscape(): string {
	return wrap(`
		<defs>
			<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
				<stop offset="0" stop-color="#fde68a"/><stop offset="0.55" stop-color="#fca5a5"/><stop offset="1" stop-color="#c084fc"/>
			</linearGradient>
			<radialGradient id="sun" cx="0.5" cy="0.5" r="0.5">
				<stop offset="0" stop-color="#fffbeb"/><stop offset="1" stop-color="#fef3c7" stop-opacity="0"/>
			</radialGradient>
		</defs>
		<rect width="480" height="360" fill="url(#sky)"/>
		<circle cx="352" cy="132" r="96" fill="url(#sun)"/>
		<circle cx="352" cy="132" r="40" fill="#fffdf5"/>
		<path d="M96 120 q8 -10 16 0" stroke="#ffffff" stroke-width="2.5" fill="none" opacity="0.7"/>
		<path d="M120 108 q8 -10 16 0" stroke="#ffffff" stroke-width="2.5" fill="none" opacity="0.7"/>
		<path d="M0 250 Q120 205 240 244 T480 232 V360 H0 Z" fill="#4ade80"/>
		<path d="M0 292 Q160 250 320 292 T480 280 V360 H0 Z" fill="#22c55e"/>
		<path d="M0 330 Q120 306 260 328 T480 322 V360 H0 Z" fill="#16a34a"/>`);
}

function character(): string {
	return wrap(`
		<defs>
			<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
				<stop offset="0" stop-color="#cffafe"/><stop offset="1" stop-color="#fbcfe8"/>
			</linearGradient>
		</defs>
		<rect width="480" height="360" fill="url(#bg)"/>
		<!-- twin-tails -->
		<path d="M176 150 q-52 30 -40 120 q22 -10 34 -60 z" fill="#2dd4bf"/>
		<path d="M304 150 q52 30 40 120 q-22 -10 -34 -60 z" fill="#2dd4bf"/>
		<!-- hair back + head -->
		<circle cx="240" cy="176" r="78" fill="#5eead4"/>
		<circle cx="240" cy="186" r="60" fill="#ffe4e6"/>
		<!-- fringe -->
		<path d="M182 168 q58 -46 116 0 q-24 -14 -58 -14 q-34 0 -58 14 z" fill="#5eead4"/>
		<!-- eyes + smile -->
		<circle cx="220" cy="188" r="7" fill="#0f766e"/><circle cx="260" cy="188" r="7" fill="#0f766e"/>
		<path d="M226 210 q14 12 28 0" stroke="#be185d" stroke-width="3.5" fill="none" stroke-linecap="round"/>
		<circle cx="210" cy="204" r="6" fill="#fda4af" opacity="0.7"/><circle cx="270" cy="204" r="6" fill="#fda4af" opacity="0.7"/>`);
}

function ui(): string {
	return wrap(`
		<rect width="480" height="360" fill="#e2e8f0"/>
		<rect x="48" y="40" width="384" height="280" rx="14" fill="#ffffff"/>
		<rect x="48" y="40" width="384" height="46" rx="14" fill="#14b8a6"/>
		<circle cx="74" cy="63" r="7" fill="#ffffff" opacity="0.9"/>
		<rect x="92" y="57" width="120" height="12" rx="6" fill="#ffffff" opacity="0.85"/>
		<rect x="72" y="112" width="220" height="14" rx="7" fill="#cbd5e1"/>
		<rect x="72" y="140" width="300" height="14" rx="7" fill="#cbd5e1"/>
		<rect x="72" y="168" width="180" height="14" rx="7" fill="#cbd5e1"/>
		<rect x="188" y="212" width="196" height="52" rx="12" fill="#ccfbf1"/>
		<rect x="204" y="228" width="150" height="10" rx="5" fill="#5eead4"/>
		<rect x="204" y="244" width="110" height="10" rx="5" fill="#5eead4"/>`);
}

function poster(): string {
	return wrap(`
		<defs>
			<linearGradient id="pg" x1="0" y1="0" x2="1" y2="1">
				<stop offset="0" stop-color="#0f172a"/><stop offset="1" stop-color="#3b0764"/>
			</linearGradient>
		</defs>
		<rect width="480" height="360" fill="url(#pg)"/>
		<circle cx="360" cy="96" r="120" fill="#7c3aed" opacity="0.35"/>
		<circle cx="120" cy="300" r="90" fill="#0ea5e9" opacity="0.3"/>
		<rect x="56" y="150" width="300" height="26" rx="6" fill="#f8fafc"/>
		<rect x="56" y="188" width="220" height="26" rx="6" fill="#38bdf8"/>
		<rect x="56" y="240" width="130" height="14" rx="7" fill="#94a3b8"/>`);
}

function abstract(seed: number): string {
	const hue = seed % 360;
	const c = (h: number) => `hsl(${h % 360} 80% 62%)`;
	return wrap(`
		<defs>
			<linearGradient id="ab" x1="0" y1="0" x2="1" y2="1">
				<stop offset="0" stop-color="hsl(${hue} 60% 92%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 60% 86%)"/>
			</linearGradient>
		</defs>
		<rect width="480" height="360" fill="url(#ab)"/>
		<circle cx="170" cy="150" r="96" fill="${c(hue)}" opacity="0.6"/>
		<circle cx="300" cy="210" r="110" fill="${c(hue + 130)}" opacity="0.55"/>
		<circle cx="250" cy="120" r="70" fill="${c(hue + 230)}" opacity="0.55"/>`);
}

function hashSeed(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
	return h;
}

/** SVG markup for a ref, scene taken from `att-<scene>-<n>` (else abstract). */
export function demoMediaSvg(ref: string): string {
	const scene = ref.split('-')[1] ?? 'abstract';
	switch (scene) {
		case 'landscape':
			return landscape();
		case 'character':
			return character();
		case 'ui':
			return ui();
		case 'poster':
			return poster();
		default:
			return abstract(hashSeed(ref));
	}
}

/** A `text/svg` Response for the demo media proxy short-circuit. */
export function demoImageResponse(ref: string): Response {
	return new Response(demoMediaSvg(ref), {
		status: 200,
		headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' }
	});
}
