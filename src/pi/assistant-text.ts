/**
 * Pure helpers for extracting assistant reply text from pi's agent messages.
 *
 * pi emits `AgentMessage` objects whose `content` is an array of typed blocks
 * (text / thinking / toolCall). The bridge only forwards the human-readable
 * text blocks to Telegram. These functions are kept free of any pi runtime
 * import so they can be unit-tested with plain object fixtures and so the
 * bundle never pulls pi's types into runtime code.
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** A minimal structural view of a pi agent message. */
export interface AgentMessageLike {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
}

const TextBlockSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() });

/**
 * Concatenate the text of every `text` block in a message, in order.
 * Non-text blocks (thinking, toolCall) and malformed blocks are ignored.
 * Returns an empty string when there is no textual content.
 */
export function getAgentMessageText(message: AgentMessageLike): string {
	const content = Array.isArray(message.content) ? message.content : [];

	const joined = content
		.flatMap((block) => Value.Check(TextBlockSchema, block) ? [block.text] : [])
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

		if (Value.Check(Type.String(), message.stopReason)) outcome.stopReason = message.stopReason;

		if (Value.Check(Type.String(), message.errorMessage)) outcome.errorMessage = message.errorMessage;

		return outcome;
	}

	return {};
}

/** The result of resolving an agent_end event for reply storage and delivery. */
export interface ResolvedReply {
	/** The assistant text to store for /resend, or undefined if none. */
	text?: string;
	/** Whether the reply should be delivered to Telegram (has an active turn). */
	shouldDeliver: boolean;
	/** Error detail when the turn failed. */
	errorMessage?: string;
}

/**
 * Decide what to store and whether to deliver after an agent_end event.
 *
 * Always extracts the assistant text so /resend can replay it later — even
 * when the prompt originated from the laptop (no activeTurn). The
 * `hasActiveTurn` flag only controls whether the caller should deliver the
 * reply to Telegram.
 */
export function resolveReplyToStore(
	messages: readonly AgentMessageLike[],
	hasActiveTurn: boolean,
): ResolvedReply {
	const outcome = extractAssistantText(messages);

	if (outcome.stopReason === "aborted") {
		return { shouldDeliver: false };
	}

	if (outcome.stopReason === "error") {
		const reply: ResolvedReply = { shouldDeliver: hasActiveTurn };

		if (outcome.errorMessage) reply.errorMessage = outcome.errorMessage;

		return reply;
	}

	if (outcome.text) {
		return { text: outcome.text, shouldDeliver: hasActiveTurn };
	}

	return { shouldDeliver: false };
}
