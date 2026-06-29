import { test, expect, describe } from "bun:test";
import { markdownToTelegramHtml } from "../src/telegram/markdown.js";

describe("markdownToTelegramHtml — lists", () => {
	test("renders a flat bullet list", () => {
		const html = markdownToTelegramHtml("- one\n- two");
		expect(html).toBe("• one\n• two");
	});

	test("renders a flat ordered list with sequential numbers", () => {
		const html = markdownToTelegramHtml("1. first\n2. second\n3. third");
		expect(html).toBe("1. first\n2. second\n3. third");
	});

	test("honours a non-1 ordered-list start", () => {
		const html = markdownToTelegramHtml("3. third\n4. fourth");
		expect(html).toBe("3. third\n4. fourth");
	});

	// Regression: a list item holding a nested list used to crash the whole
	// converter with "Token with 'list' type was not found", taking the entire
	// reply down with it (finalize() calls the converter outside try/catch).
	test("renders an ordered list nested inside a bullet item without crashing", () => {
		const md = "- parent item:\n  1. first sub\n  2. second sub\n- next parent";
		const html = markdownToTelegramHtml(md);
		expect(html).toBe("• parent item:\n  1. first sub\n  2. second sub\n• next parent");
	});

	test("renders a bullet list nested inside a bullet item", () => {
		const md = "- parent\n  - child a\n  - child b";
		const html = markdownToTelegramHtml(md);
		expect(html).toBe("• parent\n  • child a\n  • child b");
	});

	test("does not crash on a multi-paragraph (loose) list item", () => {
		const md = "- first paragraph\n\n  second paragraph\n- next item";
		const html = markdownToTelegramHtml(md);
		// Both paragraphs survive; continuation aligns under the marker.
		expect(html).toContain("• first paragraph");
		expect(html).toContain("second paragraph");
		expect(html).toContain("• next item");
	});

	test("preserves inline emphasis and code inside list items", () => {
		const html = markdownToTelegramHtml("- a **bold** and `code` item");
		expect(html).toBe("• a <b>bold</b> and <code>code</code> item");
	});

	test("renders GFM task lists with checkbox glyphs", () => {
		const html = markdownToTelegramHtml("- [x] done\n- [ ] todo");
		expect(html).toBe("☑ done\n☐ todo");
	});

	test("renders deeply nested mixed lists", () => {
		const md = "- L0\n  - L1\n    1. L2a\n    2. L2b";
		const html = markdownToTelegramHtml(md);
		expect(html).toBe("• L0\n  • L1\n    1. L2a\n    2. L2b");
	});
});
