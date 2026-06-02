// The console is a localhost operator SPA: render entirely on the client so the
// TanStack cache and remote queries have a single (browser) home. The BFF still
// runs server-side via remote functions; only the page UI skips SSR.
export const ssr = false;
export const prerender = false;
