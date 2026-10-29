import { describe, test, expect } from "bun:test";
import { resolveReplyToStore } from "../src/pi/assistant-text.js";
import type { AgentMessageLike } from "../src/pi/assistant-text.js";

/** Helper to build a minimal assistant message with text content. */
function assistantMsg(text: string): AgentMessageLike {
	return {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text }],
	};
}

describe("resolveReplyToStore", () => {
	test("returns text from successful assistant reply when there is a turn", () => {
		const messages: AgentMessageLike[] = [assistantMsg("hello from pi")];

		const result = resolveReplyToStore(messages, true);

		expect(result.text).toBe("hello from pi");
		expect(result.shouldDeliver).toBe(true);
	});

	test("returns text even when there is no active turn (laptop prompt)", () => {
		const messages: AgentMessageLike[] = [assistantMsg("laptop reply")];

		const result = resolveReplyToStore(messages, false);

		expect(result.text).toBe("laptop reply");
		expect(result.shouldDeliver).toBe(false);
	});

	test("returns undefined text when turn was aborted", () => {
		const messages: AgentMessageLike[] = [
			{ role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial" }] },
		];

		const result = resolveReplyToStore(messages, true);

		expect(result.text).toBeUndefined();
		expect(result.shouldDeliver).toBe(false);
	});

	test("returns error info when turn had an error", () => {
		const messages: AgentMessageLike[] = [
			{ role: "assistant", stopReason: "error", errorMessage: "boom", content: [] },
		];

		const result = resolveReplyToStore(messages, true);

		expect(result.text).toBeUndefined();
		expect(result.shouldDeliver).toBe(true); // error is delivered as warning
		expect(result.errorMessage).toBe("boom");
	});

	test.each(["", undefined])("omits absent or empty error details (%s)", (errorMessage) => {
		const message: AgentMessageLike = { role: "assistant", stopReason: "error", content: [] };

		if (errorMessage !== undefined) message.errorMessage = errorMessage;

		expect(resolveReplyToStore([message], true)).toStrictEqual({ shouldDeliver: true });
		expect(resolveReplyToStore([message], false)).toStrictEqual({ shouldDeliver: false });
	});

	test("returns undefined text when assistant produced no text blocks", () => {
		const messages: AgentMessageLike[] = [
			{ role: "assistant", stopReason: "stop", content: [{ type: "toolCall", text: "..." }] },
		];

		const result = resolveReplyToStore(messages, true);

		expect(result.text).toBeUndefined();
		expect(result.shouldDeliver).toBe(false);
	});
});
