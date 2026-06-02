<script lang="ts">
	import { highlightXml } from '$lib/stores/highlighter';

	let { code }: { code: string } = $props();
</script>

<!--
  Raw text in a monospace pane with XML syntax highlighting (spec §10a). The exact
  bytes are always present and selectable; highlighting never substitutes widgets.
  While Shiki loads, the unhighlighted text is shown verbatim (still copyable).
-->
{#await highlightXml(code)}
	<pre class="shiki-fallback">{code}</pre>
{:then html}
	<!-- eslint-disable-next-line svelte/no-at-html-tags — Shiki escapes content -->
	{@html html}
{:catch}
	<pre class="shiki-fallback">{code}</pre>
{/await}
