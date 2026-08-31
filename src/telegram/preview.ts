/**
 * Live "typing" previews for a single Telegram turn.
 *
 * A PreviewSession owns ONE Telegram message that it sends once and then edits
 * as the assistant streams tokens, finally replacing it with the rich, fully
 * rendered reply. Two hard constraints from Telegram shape the design:
 *
 *  1. Rate limits — editMessageText is throttled (~1 edit/sec per chat). Token
 *     updates arrive far faster, so edits are coalesced behind a throttle
 *     window (leading edge + a single trailing flush).
 *
 *  2. Parse safety — partial Markdown converted mid-stream yields unbalanced
 *     HTML (an unclosed ```code fence becomes "<pre><code>…" with no close),
 *     which Telegram rejects with a 400. So PREVIEWS stream as PLAIN text and
 *     only the FINAL reply is converted to rich Telegram HTML. The user sees
 *     live progress, then the message snaps to formatted output on completion.
 *
 * The session is constructed only when stream previews are enabled; when they
 * are off the bridge sends the final reply directly and never builds one.
 */
import { markdownToTelegramHtml, chunkTelegramHtml } from "./markdown.js";
import { containsGfmTable, isPermanentRichError } from "./rich.js";
import { stripReasoningTags } from "../pi/assistant-text.js";

const DEFAULT_THROTTLE_MS = 750;
/** Cap streamed previews under Telegram's 4096 hard limit, leaving room for "…". */
const PREVIEW_MAX = 4000;

/**
 * The Telegram operations a preview needs. parseMode is omitted for plain text.
 * The rich* methods are optional so existing fakes/tests keep working without
 * them — when absent, finalize simply never attempts the rich path.
 */
export interface PreviewTransport {
	sendMessage(opts: { chatId: number; text: string; parseMode?: "HTML" }): Promise<{ message_id: number }>;
	editMessageText(opts: { chatId: number; messageId: number; text: string; parseMode?: "HTML" }): Promise<void>;
	sendRichMessage?(opts: { chatId: number; markdown: string }): Promise<{ message_id: number }>;
	editMessageRich?(opts: { chatId: number; messageId: number; markdown: string }): Promise<void>;
}

/**
 * A one-shot trailing timer. set() replaces any pending callback; clear()
 * cancels it. Injectable so tests can fire it deterministically.
 */
export interface PreviewTimer {
	set(fn: () => void, ms: number): void;
	clear(): void;
}

function realTimer(): PreviewTimer {
	let handle: ReturnType<typeof setTimeout> | undefined;
	return {
		set(fn, ms) {
			if (handle) clearTimeout(handle);
			handle = setTimeout(fn, ms);
		},
		clear() {
			if (handle) {
				clearTimeout(handle);
				handle = undefined;
			}
		},
	};
}

export interface PreviewSessionDeps {
	transport: PreviewTransport;
	/** Minimum gap between preview edits. Default 750ms. */
	throttleMs?: number;
	/** Clock, injectable for tests. Default Date.now. */
	now?: () => number;
	/** Trailing timer, injectable for tests. Default setTimeout-backed. */
	timer?: PreviewTimer;
	/**
	 * Attempt Bot API 10.1 rich delivery for replies containing GFM tables
	 * (native bordered tables). Default true; failures fall back to HTML.
	 */
	richTables?: boolean | undefined;
	/** Whether partial assistant updates should be sent. Defaults to true. */
	streamPreviews?: boolean | undefined;
}

/** Trim and truncate preview text to a safe single-message length. */
function clip(text: string, max = PREVIEW_MAX): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Best-effort HTML→plain for the rare case Telegram rejects our HTML. */
function htmlToPlain(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

export class PreviewSession {
	private readonly chatId: number;
	private readonly transport: PreviewTransport;
	private readonly throttleMs: number;
	private readonly now: () => number;
	private readonly timer: PreviewTimer;
	private readonly richTables: boolean;
	private readonly streamPreviews: boolean;

	private messageId: number | undefined;
	private pending: string | undefined;
	private lastSent: string | undefined;
	// -Infinity guarantees the first update flushes immediately regardless of
	// the clock's starting value (Date.now in prod, 0 in tests).
	private lastFlushAt = Number.NEGATIVE_INFINITY;
	private finalized = false;
	// Latched after the first permanent rich failure (method not deployed,
	// content rejected): every later finalize goes straight to the HTML path.
	private richDisabled = false;

	constructor(chatId: number, deps: PreviewSessionDeps) {
		this.chatId = chatId;
		this.transport = deps.transport;
		this.throttleMs = deps.throttleMs ?? DEFAULT_THROTTLE_MS;
		this.now = deps.now ?? Date.now;
		this.timer = deps.timer ?? realTimer();
		this.richTables = deps.richTables ?? true;
		this.streamPreviews = deps.streamPreviews ?? true;
	}

	/**
	 * Feed the latest partial assistant text (raw Markdown). Streams it as PLAIN
	 * text, coalescing rapid calls: the first update in a window flushes
	 * immediately, later ones schedule a single trailing flush.
	 */
	async update(rawPartial: string): Promise<void> {
		if (this.finalized || !this.streamPreviews) return;
		const text = clip(stripReasoningTags(rawPartial));
		if (!text || text === this.lastSent) return;
		this.pending = text;

		const elapsed = this.now() - this.lastFlushAt;
		if (elapsed >= this.throttleMs) {
			await this.flush();
		} else {
			// Coalesce: one trailing flush carries whatever is latest by then.
			this.timer.set(() => void this.flush(), this.throttleMs - elapsed);
		}
	}

	private async flush(): Promise<void> {
		if (this.finalized) return;
		const text = this.pending;
		if (text === undefined || text === this.lastSent) return;
		this.lastSent = text;
		this.lastFlushAt = this.now();
		try {
			if (this.messageId === undefined) {
				const result = await this.transport.sendMessage({ chatId: this.chatId, text });
				this.messageId = result.message_id;
			} else {
				await this.transport.editMessageText({ chatId: this.chatId, messageId: this.messageId, text });
			}
		} catch {
			// A failed preview edit must never break the turn; the final reply
			// in finalize() is the authoritative delivery.
		}
	}

	/**
	 * Replace the streamed preview with the final, richly formatted reply.
	 *
	 * When the reply contains a GFM table and the transport supports Bot API
	 * 10.1 rich messages, the whole reply is first attempted as ONE rich send:
	 * Telegram renders the table natively (bordered, horizontally scrollable).
	 * A permanent rich failure latches rich off for the session and falls back
	 * to the classic HTML path below. Transient failures also fall back here —
	 * without a legacy resend, since the message may have reached Telegram.
	 *
	 * Without tables (or with rich unavailable) the markdown is converted to
	 * Telegram HTML and chunked. When a preview message exists, the first
	 * chunk edits it in place (no duplicate bubble); any overflow chunks are
	 * sent as new messages. With no preview message (no tokens streamed) all
	 * chunks are sent fresh. Falls back to plain text if Telegram rejects
	 * the HTML.
	 */
	async finalize(markdown: string): Promise<void> {
		this.finalized = true;
		this.timer.clear();

		const stripped = stripReasoningTags(markdown);
		if (!stripped) return; // nothing to show (e.g. a pure tool turn)

		if (this.richTables && !this.richDisabled && containsGfmTable(stripped)) {
			const delivered = await this.tryRichFinalize(stripped);
			if (delivered) return;
		}

		const chunks = chunkTelegramHtml(markdownToTelegramHtml(stripped));
		if (chunks.length === 0) return;

		if (this.messageId !== undefined) {
			await this.editRich(this.messageId, chunks[0]!);
			for (let i = 1; i < chunks.length; i++) {
				await this.sendRich(chunks[i]!);
			}
		} else {
			for (const chunk of chunks) {
				await this.sendRich(chunk);
			}
		}
	}

	/**
	 * One-shot attempt to deliver the reply as a single Bot API 10.1 rich
	 * message. Returns true when delivered; false when the caller must fall
	 * back to the HTML path. A permanent error latches rich off for the rest
	 * of the session so later table replies skip the failed attempt entirely.
	 */
	private async tryRichFinalize(markdown: string): Promise<boolean> {
		try {
			if (this.messageId !== undefined && this.transport.editMessageRich) {
				await this.transport.editMessageRich({ chatId: this.chatId, messageId: this.messageId, markdown });
				return true;
			}
			if (this.transport.sendRichMessage) {
				await this.transport.sendRichMessage({ chatId: this.chatId, markdown });
				return true;
			}
			return false; // transport has no rich support at all
		} catch (error) {
			if (isPermanentRichError(error)) this.richDisabled = true;
			return false;
		}
	}

	private async editRich(messageId: number, html: string): Promise<void> {
		try {
			await this.transport.editMessageText({ chatId: this.chatId, messageId, text: html, parseMode: "HTML" });
		} catch {
			try {
				await this.transport.editMessageText({ chatId: this.chatId, messageId, text: clip(htmlToPlain(html)) });
			} catch {
				// Give up on this message; the turn already produced output elsewhere.
			}
		}
	}

	private async sendRich(html: string): Promise<void> {
		try {
			await this.transport.sendMessage({ chatId: this.chatId, text: html, parseMode: "HTML" });
		} catch {
			try {
				await this.transport.sendMessage({ chatId: this.chatId, text: clip(htmlToPlain(html)) });
			} catch {
				// Drop a single unsendable chunk rather than throwing mid-turn.
			}
		}
	}
}
