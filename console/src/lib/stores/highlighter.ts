import { codeToHtml } from 'shiki';

/**
 * XML syntax highlighting for the verbatim renderer (spec §10a). Highlighting is
 * presentation only — Shiki escapes and preserves every byte, so the exact text
 * stays visible and copyable; there is no widget substitution.
 *
 * Dual-theme output (light/dark via CSS variables, see layout.css). Results are
 * cached by content so re-renders and tier re-layouts don't re-highlight.
 */
const cache = new Map<string, string>();

export async function highlightXml(code: string): Promise<string> {
	const hit = cache.get(code);
	if (hit !== undefined) return hit;
	const html = await codeToHtml(code, {
		lang: 'xml',
		themes: { light: 'github-light', dark: 'github-dark' },
		defaultColor: false
	});
	cache.set(code, html);
	return html;
}
