// Test helper (browser tests only): a reactive stand-in for `$app/state`'s `page`
// whose URL `goto` (also faked) replaces, so a route renders its URL-driven state.
export const fakePage = $state({ url: new URL('http://console.test/models') });

export function fakeGoto(href: string): Promise<void> {
	fakePage.url = new URL(href, 'http://console.test');
	return Promise.resolve();
}
