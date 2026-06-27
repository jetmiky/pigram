/**
 * Pure helpers for extracting assistant reply text from pi's agent messages.
 *
 * pi emits `AgentMessage` objects whose `content` is an array of typed blocks
 * (text / thinking / toolCall). The bridge only forwards the human-readable
 * text blocks to Telegram. These functions are kept free of any pi runtime
 * import so they can be unit-tested with plain object fixtures and so the
 * bundle never pulls pi's types into runtime code.
 */

/** A minimal structural view of a pi content block. */
interface ContentBlock {
	type: string;
	text?: string;
}

/** A minimal structural view of a pi agent message. */
export interface AgentMessageLike {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
}

/**
 * Concatenate the text of every `text` block in a message, in order.
 * Non-text blocks (thinking, toolCall) and malformed blocks are ignored.
 * Returns an empty string when there is no textual content.
 */
export function getAgentMessageText(message: AgentMessageLike): string {
	const content = Array.isArray(message.content) ? message.content : [];
	const joined = content
		.filter((block): block is ContentBlock => typeof block === "object" && block !== null && "type" in block)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");
	return stripReasoningTags(joined);
}

/**
 * Remove inline reasoning that some providers/proxies leak into the assistant's
 * TEXT content as literal `<thinking>...</thinking>` tags (rather than emitting
 * a structured thinking block, which we already drop in getAgentMessageText).
 *
 * Two reasons this matters for the Telegram bridge:
 *  1. The reasoning is internal — the user asked for the answer, not the chain
 *     of thought.
 *  2. `<thinking>` is not a Telegram-allowed HTML tag, so leaving it in makes
 *     Telegram reject the formatted message and the bridge falls back to plain
 *     text, losing all rich formatting for that reply.
 *
 * Handles unclosed tags (truncated/streamed reasoning) by dropping everything
 * from an opening tag to end-of-string when no closing tag is present. Matching
 * is case-insensitive and tolerant of surrounding whitespace.
 */
export function stripReasoningTags(text: string): string {
	// Remove well-formed <thinking>...</thinking> (and <think>...</think>) spans.
	let out = text.replace(/<(thinking|think)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
	// Remove a dangling opening tag with no close (e.g. truncated reasoning).
	out = out.replace(/<(thinking|think)\b[^>]*>[\s\S]*$/gi, "");
	// Collapse the blank lines the removal tends to leave behind, and trim.
	return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** The outcome of a completed agent turn, as far as Telegram delivery cares. */
export interface AssistantOutcome {
	/** Concatenated assistant text, or undefined when the turn produced none. */
	text?: string;
	/** pi stop reason, e.g. "stop" | "aborted" | "error". */
	stopReason?: string;
	/** Error detail when stopReason is "error". */
	errorMessage?: string;
}

/**
 * Find the final assistant message in a turn's message list and summarise it.
 * Scans from the end so the most recent assistant reply wins. Returns an empty
 * object when the turn contains no assistant message.
 */
export function extractAssistantText(messages: readonly AgentMessageLike[]): AssistantOutcome {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const outcome: AssistantOutcome = {};
		const text = getAgentMessageText(message);
		if (text) outcome.text = text;
		if (typeof message.stopReason === "string") outcome.stopReason = message.stopReason;
		if (typeof message.errorMessage === "string") outcome.errorMessage = message.errorMessage;
		return outcome;
	}
	return {};
}
