// Telegram HTML formatting support for AI assistant replies

import { marked } from "marked";

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

/**
 * Convert markdown to Telegram-supported HTML subset.
 * Supported tags: <b> <i> <u> <s> <a> <code> <pre> <blockquote> <tg-spoiler>
 */
export function markdownToTelegramHtml(markdown: string): string {
	let listContext: { ordered: boolean; index: number } | null = null;
	
	const renderer = {
		text(this: any, token: { text: string; tokens?: any[] }): string {
			// Block-level text tokens carry inline children (bold, code, etc.).
			// Parse them so emphasis inside lists and cells is preserved.
			return token.tokens ? this.parser.parseInline(token.tokens) : escapeTelegramHtml(token.text);
		},
		html(token: { text: string }): string {
			return escapeTelegramHtml(token.text);
		},
		strong(this: any, token: { tokens: any[] }): string {
			const content = this.parser.parseInline(token.tokens);
			return `<b>${content}</b>`;
		},
		em(this: any, token: { tokens: any[] }): string {
			const content = this.parser.parseInline(token.tokens);
			return `<i>${content}</i>`;
		},
		link(this: any, token: { href: string; tokens: any[] }): string {
			const content = this.parser.parseInline(token.tokens);
			return `<a href="${token.href}">${content}</a>`;
		},
		paragraph(this: any, token: { tokens: any[] }): string {
			// Telegram HTML does not support <p>; emit inline content with paragraph spacing
			return this.parser.parseInline(token.tokens) + '\n\n';
		},
		heading(this: any, token: { tokens: any[] }): string {
			const content = stripBold(this.parser.parseInline(token.tokens));
			return `<b>${content}</b>\n\n`;
		},
		// Telegram HTML has no <hr>; emitting one makes Telegram reject the whole
		// message (400) and the bridge falls back to plain text. Render a visual
		// separator with a line of box-drawing characters instead.
		hr(): string {
			return "──────────\n\n";
		},
		list(this: any, token: { ordered: boolean; items: any[] }): string {
			listContext = { ordered: token.ordered, index: 0 };
			const items = token.items.map((item: any) => {
				const prefix = listContext!.ordered ? `${++listContext!.index}. ` : '• ';
				// Parse inline tokens so bold/italic/code inside list items render.
				return prefix + this.parser.parseInline(item.tokens);
			});
			listContext = null;
			return items.join('\n') + '\n\n';
		},
		// Telegram has no <table> primitive. Render tables as a fixed-width
		// <pre> block: a monospace font keeps columns aligned and Telegram lets
		// <pre> scroll horizontally on mobile, so the grid survives. Cells are
		// reduced to plain text (no inline tags inside <pre>) and padded to the
		// widest cell per column using display width (so emoji/CJK align too).
		// A box-drawing divider under the header gives it the table look.
		table(this: any, token: { header: any[]; rows: any[][] }): string {
			const toText = (cell: any): string =>
				stripTags(this.parser.parseInline(cell.tokens)).replace(/\s+/g, " ").trim();

			const header = token.header.map(toText);
			const rows = token.rows.map((row: any[]) => row.map(toText));
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
	const html = marked.parse(markdown) as string;
	
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
	
	while (i < html.length) {
		// Check if we need to split before adding more content
		// Leave room for closing tags (estimate 50 chars per tag)
		const closingTagsLength = tagStack.reduce((sum, tag) => sum + tag.name.length + 3, 0); // </name>
		if (currentChunk.length + closingTagsLength >= maxLength) {
			// Close all open tags
			for (let j = tagStack.length - 1; j >= 0; j--) {
				currentChunk += `</${tagStack[j]!.name}>`;
			}
			chunks.push(currentChunk);
			
			// Start new chunk by reopening tags
			currentChunk = tagStack.map(tag => tag.fullTag).join('');
		}
		
		// Parse next token
		if (html[i]! === '<') {
			// Find end of tag
			const tagEnd = html.indexOf('>', i);
			if (tagEnd === -1) break; // Malformed HTML
			
			const tag = html.slice(i, tagEnd + 1);
			currentChunk += tag;
			
			// Determine tag type
			if (tag.startsWith('</')) {
				// Closing tag
				const tagName = tag.slice(2, -1).trim();
				// Pop matching opening tag from stack
				for (let j = tagStack.length - 1; j >= 0; j--) {
					if (tagStack[j]!.name === tagName) {
						tagStack.splice(j, 1);
						break;
					}
				}
			} else if (!tag.endsWith('/>') && !tag.startsWith('<!')) {
				// Opening tag (not self-closing, not comment)
				const spaceIndex = tag.indexOf(' ');
				const closeIndex = tag.indexOf('>');
				const tagName = tag.slice(1, spaceIndex > 0 && spaceIndex < closeIndex ? spaceIndex : closeIndex).trim();
				tagStack.push({ name: tagName, fullTag: tag });
			}
			// Self-closing or comments are not tracked
			
			i = tagEnd + 1;
		} else {
			// Regular text content
			currentChunk += html[i]!;
			i++;
		}
	}
	
	// Add final chunk
	if (currentChunk.length > 0) {
		chunks.push(currentChunk);
	}
	
	return chunks;
}
