/**
 * Bot API 10.1 Rich Message support for markdown tables.
 *
 * Telegram's HTML parse mode has no <table> primitive, so pigram renders
 * tables as a fixed-width <pre> grid. That works but is static: no borders,
 * no horizontal scroll on narrow phones. Bot API 10.1 added sendRichMessage,
 * which accepts raw markdown and renders GFM pipe tables as NATIVE bordered
 * tables the client can scroll horizontally.
 *
 * This module is deliberately small: it answers two questions.
 *
 *  1. does this reply contain a GFM table? (should we attempt rich at all)
 *  2. did rich delivery fail for a PERMANENT reason? (stop trying this session)
 *
 * Everything else — sending, editing, fallback to HTML — stays in preview.ts
 * and index.ts so the failure paths remain exactly where they are today.
 */

/**
 * Matches a GFM table delimiter row: optional outer pipes, cells of dashes
 * with optional alignment colons, separated by pipes. Requires at least one
 * internal pipe so a lone `---` horizontal rule is NOT matched.
 */
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;

/** A data row is any non-empty line containing a pipe. */
function isTableRow(line: string): boolean {
	const stripped = line.trim();

	return stripped.length > 0 && stripped.includes("|");
}

/**
 * True when the markdown contains a complete GFM pipe table: a header row
 * followed by a delimiter row. Fenced code blocks are skipped — a table
 * inside ``` fences is example text, not a table to render natively.
 */
export function containsGfmTable(markdown: string): boolean {
	if (!markdown.includes("|") || !markdown.includes("-")) return false;

	const lines = markdown.split("\n");
	let inFence = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;

		if (line.trimStart().startsWith("```")) {
			inFence = !inFence;
			continue;
		}

		if (inFence) continue;

		if (
			line.includes("|") &&
			i + 1 < lines.length &&
			TABLE_SEPARATOR_RE.test(lines[i + 1]!)
		) {
			return true;
		}
	}

	return false;
}

/**
 * Split a GFM row into trimmed cell values.
 * Exported for tests and future reuse.
 */
export function splitTableRow(row: string): string[] {
	let s = row.trim();

	if (s.startsWith("|")) s = s.slice(1);

	if (s.endsWith("|")) s = s.slice(0, -1);

	return s.split("|").map((c) => c.trim());
}

/**
 * True when a rich-send error is permanent: retrying sendRichMessage with
 * different content of the same shape will fail again. Capability errors
 * (method not deployed / old server) and BadRequest (content rejected by
 * the rich parser) both qualify — the caller falls back to the HTML path.
 * Transient failures (network, 5xx, rate limit) do NOT qualify: the message
 * may have reached Telegram, so legacy-resending risks a duplicate bubble.
 */
export function isPermanentRichError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();

	return (
		message.includes("bad request") ||
		message.includes("not found") ||
		message.includes("unauthorized") ||
		message.includes("forbidden") ||
		message.includes("unsupported")
	);
}
