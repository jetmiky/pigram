// Telegram HTML formatting support for AI assistant replies

import { marked, type Parser, type RendererObject, type Tokens } from "marked";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const TextTokenSchema = Type.Object({ text: Type.String() });
const ListStartSchema = Type.Number({ exclusiveMinimum: 0 });

export function escapeTelegramHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Telegram rejects nested identical tags (e.g. <b><b>x</b></b>). Strip inner bold
// before re-wrapping content that is already emphasized as a whole (headings, cells).
function stripBold(text: string): string {
	return text.replace(/<\/?b>/g, "");
}

// Strip ALL HTML tags, leaving escaped entities (&lt; etc.) intact. Used for
// table cells, which must be plain text so monospace columns line up.
function stripTags(html: string): string {
	return html.replace(/<[^>]+>/g, "");
}

// Decode the HTML entities this module emits, so a cell's *display* width is
// measured on the glyphs the user sees (`<`), not the escaped form (`&lt;`).
// Decode &amp; last to avoid turning "&amp;lt;" into "<".
function decodeTelegramHtml(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}

// True for code points that occupy two cells in a monospace font (CJK,
// fullwidth forms, and the symbol/emoji blocks). Approximate but covers the
// characters that actually show up in assistant tables, including ✅ ⚠ 🆕.
function isWideCodePoint(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
		(cp >= 0x2329 && cp <= 0x232a) || // angle brackets
		(cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi
		(cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … CJK symbols
		(cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
		(cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
		(cp >= 0xa000 && cp <= 0xa4cf) || // Yi
		(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
		(cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
		(cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x2600 && cp <= 0x27bf) || // Misc symbols + Dingbats (✅=2705, ⚠=26a0)
		(cp >= 0x1f000 && cp <= 0x1faff) // Emoji & pictographs (🆕=1f195)
	);
}

// Monospace display width of a string. Zero-width joiners, variation selectors
// and combining marks contribute 0; wide glyphs contribute 2; everything else 1.
export function displayWidth(text: string): number {
	let width = 0;

	for (const ch of text) {
		const cp = ch.codePointAt(0)!;

		if (cp === 0x200d) continue; // zero-width joiner

		if (cp >= 0xfe00 && cp <= 0xfe0f) continue; // variation selectors

		if (cp >= 0x0300 && cp <= 0x036f) continue; // combining diacriticals
		width += isWideCodePoint(cp) ? 2 : 1;
	}

	return width;
}

// Right-pad a cell with spaces to a target monospace width.
function padCell(cell: string, target: number): string {
	const pad = target - displayWidth(decodeTelegramHtml(cell));

	return pad > 0 ? cell + " ".repeat(pad) : cell;
}

// Extract the inline content of a blockquote: its .tokens hold BLOCK-level
// tokens (paragraph, nested blockquote, code), and parseInline throws on
// those ("Token with 'paragraph' type was not found"). Recurse through the
// wrappers and parseInline only the inline leaves. Multi-line results are
// re-indented under the list marker by renderList's continuation regex.
function renderQuoteContent(token: Tokens.Blockquote | Tokens.Generic, parser: Parser): string {
	return (token.tokens ?? [])
		.map((t) => {
			if (t.type === "blockquote") return renderQuoteContent(t, parser);

			if (t.type === "space") return "";

			if ("tokens" in t && t.tokens) return parser.parseInline(t.tokens);

			return Value.Check(TextTokenSchema, t) ? escapeTelegramHtml(t.text) : "";
		})
		.filter((s: string) => s.length > 0)
		.join("\n");
}

// Telegram HTML has no <ul>/<ol>; lists are rendered as indented plain-text
// lines. A list item can hold BLOCK children (a nested list, a second
// paragraph), so we cannot just parseInline its tokens — that throws
// "Token with 'list' type was not found". Instead we walk items ourselves:
// inline children are parsed inline, nested lists recurse one indent deeper,
// and the renderer fully owns the recursion (marked never re-enters for the
// nested lists because we never hand them back to the parser).
function renderList(token: Tokens.List | Tokens.Generic, parser: Parser, depth: number): string {
	const indent = "  ".repeat(depth);
	const lines: string[] = [];
	let ordinal = Value.Check(ListStartSchema, token.start) ? token.start : 1;

	for (const item of token.items) {
		let marker: string;

		if (item.task) {
			marker = item.checked ? "☑ " : "☐ ";
		} else if (token.ordered) {
			marker = `${ordinal++}. `;
		} else {
			marker = "• ";
		}

		const inlineParts: string[] = [];
		const nestedBlocks: string[] = [];

		for (const child of item.tokens ?? []) {
			if (child.type === "list") {
				nestedBlocks.push(renderList(child, parser, depth + 1));
			} else if (child.type === "blockquote") {
				// Blockquote children hold BLOCK tokens; parseInline would throw.
				nestedBlocks.push(renderQuoteContent(child, parser));
			} else if (child.type === "space") {
				// blank line between loose-list paragraphs — skip
			} else if (child.tokens) {
				inlineParts.push(parser.parseInline(child.tokens));
			} else if (Value.Check(TextTokenSchema, child)) {
				inlineParts.push(escapeTelegramHtml(child.text));
			}
		}

		// Multiple paragraphs in one item collapse onto a continuation line,
		// indented under the marker so the bullet hierarchy stays readable.
		const continuation = `\n${indent}${" ".repeat(marker.length)}`;
		const head = inlineParts.join(continuation).replace(/\s*\n\s*/g, continuation);
		lines.push(`${indent}${marker}${head}`);

		for (const block of nestedBlocks) lines.push(block);
	}

	return lines.join("\n");
}

/**
 * Convert markdown to Telegram-supported HTML subset.
 * Supported tags: <b> <i> <u> <s> <a> <code> <pre> <blockquote> <tg-spoiler>
 */
/**
 * Strip raw HTML tags that the LLM emits instead of markdown syntax.
 *
 * LLMs sometimes produce `<br>`, `<b>text</b>`, `<code>x</code>` etc. instead
 * of markdown equivalents. Without this step, `marked` treats them as raw HTML
 * tokens, the `html()` renderer escapes them to entities (`&lt;br&gt;`), and
 * Telegram shows literal tag text.
 *
 * Strategy: stash fenced code blocks and inline code first (their contents must
 * not be touched), convert supported inline tags to markdown equivalents, strip
 * unsupported tags (keeping their text content), then restore the stashed code.
 */
function sanitizeRawHtml(markdown: string): string {
	const stashed: string[] = [];

	const stash = (s: string) => {
		stashed.push(s);

		return `\0${stashed.length - 1}\0`;
	};

	// 1. Stash fenced code blocks — their content must stay verbatim.
	let text = markdown.replace(/```[^\n]*\n?([\s\S]*?)```/g, (m) => stash(m));

	// 2. Stash inline code — backtick content must stay verbatim.
	text = text.replace(/`([^`]+)`/g, (m) => stash(m));

	// 3. <br> variants → newline (Telegram has no <br>).
	text = text.replace(/<br\s*\/?>/gi, "\n");

	// 4. </br> → remove (invalid void-element closing tag).
	text = text.replace(/<\/br>/gi, "");

	// 5. Convert supported inline HTML tags to markdown equivalents.
	//    Process inner tags first (<code> before <b>) so nesting works.
	text = text.replace(/<code>([\s\S]*?)<\/code>/gi, (_, inner) => `\`${inner}\``);
	text = text.replace(/<strong>([\s\S]*?)<\/strong>/gi, (_, inner) => `**${inner}**`);
	text = text.replace(/<b>([\s\S]*?)<\/b>/gi, (_, inner) => `**${inner}**`);
	text = text.replace(/<em>([\s\S]*?)<\/em>/gi, (_, inner) => `*${inner}*`);
	text = text.replace(/<i>([\s\S]*?)<\/i>/gi, (_, inner) => `*${inner}*`);

	// 6. Strip unsupported tags (keep text content). Covers <div>, <span>,
	//    <p>, <ul>, <ol>, <li>, <table>, etc. — anything Telegram won't render.
	text = text.replace(/<\/?[a-zA-Z][^>]*>/g, "");

	// 7. Restore NUL-delimited code placeholders.
	text = text.replace(/\0(\d+)\0/g, (_, i: string) => stashed[Number(i)]!);

	return text;
}

export function markdownToTelegramHtml(markdown: string): string {
	const sanitized = sanitizeRawHtml(markdown);

	const renderer: RendererObject = {
		text(token): string {
			// Block-level text tokens carry inline children (bold, code, etc.).
			// Parse them so emphasis inside lists and cells is preserved.
			return "tokens" in token && token.tokens ? this.parser.parseInline(token.tokens) : escapeTelegramHtml(token.text);
		},
		html(token): string {
			return escapeTelegramHtml(token.text);
		},
		strong(token): string {
			const content = this.parser.parseInline(token.tokens);

			return `<b>${content}</b>`;
		},
		em(token): string {
			const content = this.parser.parseInline(token.tokens);

			return `<i>${content}</i>`;
		},
		link(token): string {
			const content = this.parser.parseInline(token.tokens);

			return `<a href="${token.href}">${content}</a>`;
		},
		paragraph(token): string {
			// Telegram HTML does not support <p>; emit inline content with paragraph spacing
			return this.parser.parseInline(token.tokens) + '\n\n';
		},
		heading(token): string {
			const content = stripBold(this.parser.parseInline(token.tokens));

			return `<b>${content}</b>\n\n`;
		},
		// Telegram HTML has no <hr>; emitting one makes Telegram reject the whole
		// message (400) and the bridge falls back to plain text. Render a visual
		// separator with a line of box-drawing characters instead.
		hr(): string {
			return "──────────\n\n";
		},
		br(): string {
			return "\n";
		},
		list(token): string {
			return renderList(token, this.parser, 0) + '\n\n';
		},
		// Telegram has no <table> primitive. Render tables as a fixed-width
		// <pre> block: a monospace font keeps columns aligned and Telegram lets
		// <pre> scroll horizontally on mobile, so the grid survives. Cells are
		// reduced to plain text (no inline tags inside <pre>) and padded to the
		// widest cell per column using display width (so emoji/CJK align too).
		// A box-drawing divider under the header gives it the table look.
		table(token): string {
			const toText = (cell: Tokens.TableCell): string =>
				stripTags(this.parser.parseInline(cell.tokens)).replace(/\s+/g, " ").trim();

			const header = token.header.map(toText);
			const rows = token.rows.map((row) => row.map(toText));
			const columnCount = header.length;

			// Widest display-width cell per column drives the padding target.
			const widths: number[] = header.map((cell, col) => {
				let max = displayWidth(decodeTelegramHtml(cell));

				for (const row of rows) {
					const value = row[col] ?? "";
					max = Math.max(max, displayWidth(decodeTelegramHtml(value)));
				}

				return max;
			});

			const renderRow = (cells: string[]): string =>
				cells
					.map((cell, col) => (col < columnCount - 1 ? padCell(cell, widths[col]!) : cell))
					.join("  ");

			const divider = widths.map((w) => "─".repeat(Math.max(1, w))).join("──");

			const lines = [renderRow(header), divider, ...rows.map((row) => renderRow(row))];

			// The whole grid is escaped plain text wrapped in <pre>.
			return `<pre>${lines.join("\n")}</pre>\n\n`;
		},
	};
	
	marked.use({ renderer });
	const html = marked.parse(sanitized, { async: false });
	
	// Collapse the extra blank lines introduced by block separators and trim edges
	return html.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Split HTML into <=maxLength chunks while preserving tag balance.
 * Open tags are closed at chunk boundaries and reopened in the next chunk.
 */
export function chunkTelegramHtml(html: string, maxLength = 4096): string[] {
	if (html.length <= maxLength) {
		return [html];
	}

	const chunks: string[] = [];
	const tagStack: Array<{ name: string; fullTag: string }> = [];
	let currentChunk = '';
	let i = 0;

	/** Total length of closing tags needed for the current stack. */
	const closingLen = () => tagStack.reduce((s, t) => s + t.name.length + 3, 0); // </name>

	/** Close all open tags, push the chunk, reopen tags in a fresh chunk. */
	const flush = () => {
		for (let j = tagStack.length - 1; j >= 0; j--) {
			currentChunk += `</${tagStack[j]!.name}>`;
		}

		chunks.push(currentChunk);
		currentChunk = tagStack.map(t => t.fullTag).join('');
	};

	while (i < html.length) {
		if (html[i]! === '<') {
			// Find end of tag
			const tagEnd = html.indexOf('>', i);

			if (tagEnd === -1) break; // Malformed HTML

			const tag = html.slice(i, tagEnd + 1);
			const tagLen = tagEnd - i + 1;

			// Calculate how this tag changes the closing-tag budget.
			// Opening tags ADD to the stack (future closing cost goes up);
			// closing tags REMOVE from the stack (cost goes down).
			let closingDelta = 0;

			if (tag.startsWith('</')) {
				const name = tag.slice(2, -1).trim();
				closingDelta = -(name.length + 3); // </name>
			} else if (!tag.endsWith('/>') && !tag.startsWith('<!')) {
				const sp = tag.indexOf(' ');
				const gt = tag.indexOf('>');
				const name = tag.slice(1, sp > 0 && sp < gt ? sp : gt).trim();
				closingDelta = name.length + 3;
			}

			// Check BEFORE adding: would this tag + updated closing tags overflow?
			if (currentChunk.length > 0 && currentChunk.length + tagLen + closingLen() + closingDelta > maxLength) {
				flush();
			}

			currentChunk += tag;

			// Update tagStack
			if (tag.startsWith('</')) {
				const tagName = tag.slice(2, -1).trim();

				for (let j = tagStack.length - 1; j >= 0; j--) {
					if (tagStack[j]!.name === tagName) {
						tagStack.splice(j, 1);
						break;
					}
				}
			} else if (!tag.endsWith('/>') && !tag.startsWith('<!')) {
				const spaceIndex = tag.indexOf(' ');
				const closeIndex = tag.indexOf('>');
				const tagName = tag.slice(1, spaceIndex > 0 && spaceIndex < closeIndex ? spaceIndex : closeIndex).trim();
				tagStack.push({ name: tagName, fullTag: tag });
			}
			// Self-closing or comments are not tracked

			i = tagEnd + 1;
		} else {
			// Regular text content — check after adding each character
			currentChunk += html[i]!;
			i++;

			if (currentChunk.length + closingLen() >= maxLength) {
				flush();
			}
		}
	}

	// Add final chunk
	if (currentChunk.length > 0) {
		chunks.push(currentChunk);
	}

	return chunks;
}

/**
 * Split plain text into <=maxLength chunks at paragraph boundaries (`\\n\\n`).
 * Falls back to splitting on single newlines, then character boundaries.
 * Used for assistant replies sent as plain text (richText disabled).
 */
export function chunkPlainText(text: string, maxLength = 4096): string[] {
	if (text.length <= maxLength) {
		return [text];
	}

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > maxLength) {
		// Try to split at the last paragraph break within maxLength
		let splitAt = remaining.lastIndexOf('\n\n', maxLength);

		if (splitAt <= 0) {
			// No paragraph break — try single newline
			splitAt = remaining.lastIndexOf('\n', maxLength);
		}

		if (splitAt <= 0) {
			// No newline at all — hard split at maxLength
			splitAt = maxLength;
		}

		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).replace(/^\n+/, '');
	}

	if (remaining.length > 0) {
		chunks.push(remaining);
	}

	return chunks;
}
