import { test, expect } from "bun:test";
import { markdownToTelegramHtml, chunkTelegramHtml } from "../src/telegram/markdown";

test("markdownToTelegramHtml converts **bold** to <b>", () => {
	expect(markdownToTelegramHtml("**bold**")).toBe("<b>bold</b>");
});

test("markdownToTelegramHtml converts *italic* to <i>", () => {
	expect(markdownToTelegramHtml("*italic*")).toBe("<i>italic</i>");
});

test("markdownToTelegramHtml converts _italic_ to <i>", () => {
	expect(markdownToTelegramHtml("_italic_")).toBe("<i>italic</i>");
});

test("markdownToTelegramHtml converts `code` to <code>", () => {
	expect(markdownToTelegramHtml("`code`")).toBe("<code>code</code>");
});

test("markdownToTelegramHtml escapes content in inline code", () => {
	expect(markdownToTelegramHtml("`<div>&test</div>`")).toBe("<code>&lt;div&gt;&amp;test&lt;/div&gt;</code>");
});

// Regression guard for the double-escape bug: feeding ALREADY-rendered Telegram
// HTML back through the converter escapes its tags into literal text
// (<pre> -> &lt;pre&gt;, &lt; -> &amp;lt;). This is why the bridge must route
// pre-formatted HTML (e.g. the /help block) through a verbatim sender and only
// ever run pi's raw Markdown through this function. See src/index.ts senders.
test("markdownToTelegramHtml double-escapes pre-rendered HTML (must not be called twice)", () => {
	const alreadyHtml = "<pre>new - start a session\ngit - run /git &lt;status&gt;</pre>";
	const result = markdownToTelegramHtml(alreadyHtml);
	expect(result).toContain("&lt;pre&gt;");
	expect(result).toContain("&amp;lt;");
	// Proves the converter is NOT safe to apply to its own output.
	expect(result).not.toBe(alreadyHtml);
});

test("markdownToTelegramHtml converts fenced code block with language", () => {
	const markdown = "```js\nconst x = 1;\n```";
	const expected = '<pre><code class="language-js">const x = 1;\n</code></pre>';
	expect(markdownToTelegramHtml(markdown)).toBe(expected);
});

test("markdownToTelegramHtml escapes content in fenced code blocks", () => {
	const markdown = "```js\nif (x < 10 && y > 5) { return true; }\n```";
	const expected = '<pre><code class="language-js">if (x &lt; 10 &amp;&amp; y &gt; 5) { return true; }\n</code></pre>';
	expect(markdownToTelegramHtml(markdown)).toBe(expected);
});

test("markdownToTelegramHtml converts links to <a> tags", () => {
	expect(markdownToTelegramHtml("[link text](https://example.com)")).toBe('<a href="https://example.com">link text</a>');
});

test("markdownToTelegramHtml escapes link text", () => {
	expect(markdownToTelegramHtml("[<click> & go](https://example.com)")).toBe('<a href="https://example.com">&lt;click&gt; &amp; go</a>');
});

test("markdownToTelegramHtml converts headings to bold", () => {
	expect(markdownToTelegramHtml("# Heading 1")).toBe("<b>Heading 1</b>");
	expect(markdownToTelegramHtml("## Heading 2")).toBe("<b>Heading 2</b>");
	expect(markdownToTelegramHtml("### Heading 3")).toBe("<b>Heading 3</b>");
});

test("markdownToTelegramHtml converts bullet lists with • prefix", () => {
	const markdown = "- item 1\n- item 2\n- item 3";
	const expected = "• item 1\n• item 2\n• item 3";
	expect(markdownToTelegramHtml(markdown)).toBe(expected);
});

test("markdownToTelegramHtml converts numbered lists with number prefix", () => {
	const markdown = "1. first\n2. second\n3. third";
	const expected = "1. first\n2. second\n3. third";
	expect(markdownToTelegramHtml(markdown)).toBe(expected);
});

test("markdownToTelegramHtml escapes raw HTML characters in text", () => {
	expect(markdownToTelegramHtml("Use <div> & <span> tags")).toBe("Use &lt;div&gt; &amp; &lt;span&gt; tags");
});

test("markdownToTelegramHtml escapes HTML in bold text", () => {
	expect(markdownToTelegramHtml("**<important> & critical**")).toBe("<b>&lt;important&gt; &amp; critical</b>");
});

test("markdownToTelegramHtml flattens 2-column tables into labeled bullets", () => {
	const markdown = "| Col1 | Col2 |\n|------|------|\n| A    | B    |";
	const result = markdownToTelegramHtml(markdown);
	// 2-column rows become "• <b>first</b>: second"
	expect(result).toContain("\u2022 <b>A</b>: B");
	// No table HTML tags
	expect(result).not.toContain("<table>");
	expect(result).not.toContain("<tr>");
});

test("markdownToTelegramHtml flattens multi-column tables into titled blocks", () => {
	const markdown = [
		"| Dimension | Junior | Senior |",
		"| --- | --- | --- |",
		"| Focus | Writes code | Solves the right problem |",
	].join("\n");
	const result = markdownToTelegramHtml(markdown);
	// First column becomes the block title, remaining columns keyed by header
	expect(result).toContain("<b>Focus</b>");
	expect(result).toContain("\u2022 Junior: Writes code");
	expect(result).toContain("\u2022 Senior: Solves the right problem");
});

test("markdownToTelegramHtml renders bold inside list items", () => {
	const result = markdownToTelegramHtml("- A bullet with **bold label** and text");
	expect(result).toContain("<b>bold label</b>");
	expect(result).not.toContain("**");
});

test("markdownToTelegramHtml renders bold inside table cells without nesting", () => {
	const markdown = "| Setting | Value |\n| --- | --- |\n| **Timeout** | 30s |";
	const result = markdownToTelegramHtml(markdown);
	expect(result).toContain("<b>Timeout</b>: 30s");
	// No invalid nested identical tags
	expect(result).not.toContain("<b><b>");
	expect(result).not.toContain("**");
});

test("markdownToTelegramHtml does not nest bold inside headings", () => {
	const result = markdownToTelegramHtml("## A heading with **bold** inside");
	expect(result).toContain("<b>A heading with bold inside</b>");
	expect(result).not.toContain("<b><b>");
});

// HTML chunking tests

test("chunkTelegramHtml returns single chunk for short HTML", () => {
	const html = "<b>short message</b>";
	expect(chunkTelegramHtml(html)).toEqual([html]);
});

test("chunkTelegramHtml returns single chunk at exactly 4096 chars", () => {
	const html = "x".repeat(4096);
	expect(chunkTelegramHtml(html)).toEqual([html]);
});

test("chunkTelegramHtml splits long HTML and balances tags", () => {
	// Create HTML that's longer than 4096 with nested tags
	const longText = "x".repeat(4100);
	const html = `<b>${longText}</b><i>more text here</i>`;
	
	const chunks = chunkTelegramHtml(html);
	
	// Should be split into multiple chunks
	expect(chunks.length).toBeGreaterThan(1);
	
	// Each chunk should be <= 4096
	for (const chunk of chunks) {
		expect(chunk.length).toBeLessThanOrEqual(4096);
	}
	
	// First chunk should have closing </b> for the open <b>
	expect(chunks[0]).toContain("</b>");
	
	// Second chunk should reopen <b> to continue the bold text
	expect(chunks[1]).toStartWith("<b>");
});

test("chunkTelegramHtml handles oversized code blocks with language attribute", () => {
	const longCode = "const x = 1;\n".repeat(400); // Creates ~5200 chars
	const html = `<pre><code class="language-js">${longCode}</code></pre>`;
	
	const chunks = chunkTelegramHtml(html);
	
	// Should be split into multiple chunks
	expect(chunks.length).toBeGreaterThan(1);
	
	// Each chunk should be <= 4096
	for (const chunk of chunks) {
		expect(chunk.length).toBeLessThanOrEqual(4096);
	}
	
	// First chunk should close the code block
	expect(chunks[0]).toContain("</code>");
	expect(chunks[0]).toContain("</pre>");
	
	// Second chunk should reopen with the language attribute preserved
	expect(chunks[1]).toStartWith('<pre><code class="language-js">');
});

// --- Horizontal rule (<hr> is NOT a Telegram-allowed tag) ---
// Regression: emitting <hr> makes Telegram reject the message (400) and the
// bridge silently falls back to plain text, killing formatting for the whole
// reply. A rule must become a plain-text separator instead.

test("markdownToTelegramHtml renders --- as a text separator, not <hr>", () => {
	const out = markdownToTelegramHtml("Above\n\n---\n\nBelow");
	expect(out).not.toContain("<hr");
	expect(out).toContain("──────────");
	expect(out).toContain("Above");
	expect(out).toContain("Below");
});

test("markdownToTelegramHtml renders *** rule as a text separator", () => {
	expect(markdownToTelegramHtml("A\n\n***\n\nB")).not.toContain("<hr");
});

// --- Tag safety guard: every construct must yield only Telegram-allowed tags ---
// Telegram's HTML mode allows a fixed whitelist; any other tag triggers a 400.
// This guard catches a renderer change that introduces an unsupported tag.

test("markdownToTelegramHtml only emits Telegram-allowed HTML tags", () => {
	const allowed = new Set([
		"b", "strong", "i", "em", "u", "ins", "s", "strike", "del",
		"a", "code", "pre", "blockquote", "tg-spoiler", "tg-emoji", "span",
	]);
	const kitchenSink = [
		"# Heading",
		"",
		"**bold** and *italic* and `inline code`.",
		"",
		"```js",
		"const x = 1;",
		"```",
		"",
		"> a block quote",
		"",
		"---",
		"",
		"| Name | Age |",
		"|------|-----|",
		"| Alice | 30 |",
		"",
		"- bullet one",
		"- bullet two",
		"",
		"[a link](https://example.com)",
	].join("\n");
	const html = markdownToTelegramHtml(kitchenSink);
	const usedTags = [...new Set([...html.matchAll(/<\/?([a-zA-Z0-9-]+)/g)].map((m) => m[1]!))];
	const disallowed = usedTags.filter((t) => !allowed.has(t));
	expect(disallowed).toEqual([]);
});
