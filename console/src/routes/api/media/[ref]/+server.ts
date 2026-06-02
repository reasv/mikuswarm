import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { apiBaseUrl, authHeaders } from '$lib/server/config';

/**
 * Same-origin image proxy (spec §8 `/api/media/:ref`). Image bytes are binary, so
 * this is a route handler rather than a (JSON/devalue) remote function. The bearer
 * token is attached server-side here; the browser uses `<img src="/api/media/{ref}">`
 * and never sees the token.
 */
export const GET: RequestHandler = async ({ params, fetch, setHeaders }) => {
	const ref = encodeURIComponent(params.ref);
	const upstream = await fetch(`${apiBaseUrl}/api/media/${ref}`, { headers: authHeaders() });
	if (!upstream.ok || !upstream.body) {
		throw error(upstream.status || 502, 'media fetch failed');
	}
	const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
	const cacheControl = upstream.headers.get('cache-control') ?? 'private, max-age=300';
	setHeaders({ 'content-type': contentType, 'cache-control': cacheControl });
	return new Response(upstream.body, { status: 200 });
};
