import { test, expect } from "bun:test";
import { getAgentMessageText, extractAssistantText, stripReasoningTags, type AgentMessageLike } from "../src/pi/assistant-text.js";

test("getAgentMessageText concatenates text blocks in order", () => {
	const msg: AgentMessageLike = {
		role: "assistant",
		content: [
			{ type: "text", text: "Hello " },
			{ type: "text", text: "world" },
		],
	};
	expect(getAgentMessageText(msg)).toBe("Hello world");
});

test("getAgentMessageText ignores thinking and toolCall blocks", () => {
	const msg: AgentMessageLike = {
		role: "assistant",
		content: [
			{ type: "thinking", text: "hmm" },
			{ type: "text", text: "answer" },
			{ type: "toolCall", text: "should-not-appear" },
		],
	};
	expect(getAgentMessageText(msg)).toBe("answer");
});

test("getAgentMessageText returns empty string when no text blocks", () => {
	const msg: AgentMessageLike = { role: "assistant", content: [{ type: "toolCall" }] };
	expect(getAgentMessageText(msg)).toBe("");
});

test("getAgentMessageText tolerates non-array content", () => {
	expect(getAgentMessageText({ role: "assistant", content: undefined })).toBe("");
	expect(getAgentMessageText({ role: "assistant" })).toBe("");
});

test("getAgentMessageText skips malformed blocks", () => {
	const msg: AgentMessageLike = {
		role: "assistant",
		content: [null, "string-block", { type: "text", text: "ok" }, { type: "text" }],
	};
	expect(getAgentMessageText(msg)).toBe("ok");
});

test("extractAssistantText picks the last assistant message", () => {
	const messages: AgentMessageLike[] = [
		{ role: "user", content: [{ type: "text", text: "hi" }] },
		{ role: "assistant", content: [{ type: "text", text: "first" }] },
		{ role: "user", content: [{ type: "text", text: "again" }] },
		{ role: "assistant", content: [{ type: "text", text: "second" }] },
	];
	expect(extractAssistantText(messages).text).toBe("second");
});

test("extractAssistantText surfaces stopReason and errorMessage", () => {
	const messages: AgentMessageLike[] = [
		{ role: "assistant", content: [], stopReason: "error", errorMessage: "boom" },
	];
	const outcome = extractAssistantText(messages);
	expect(outcome.stopReason).toBe("error");
	expect(outcome.errorMessage).toBe("boom");
	expect(outcome.text).toBeUndefined();
});

test("extractAssistantText reports aborted turns", () => {
	const messages: AgentMessageLike[] = [
		{ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted" },
	];
	const outcome = extractAssistantText(messages);
	expect(outcome.stopReason).toBe("aborted");
	expect(outcome.text).toBe("partial");
});

test("extractAssistantText returns empty object when no assistant message", () => {
	const messages: AgentMessageLike[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
	expect(extractAssistantText(messages)).toEqual({});
});

// --- Reasoning-tag stripping (provider/proxy leak defense) ---

test("stripReasoningTags removes a well-formed thinking block", () => {
	const input = "<thinking>let me compute 19*23</thinking>\n\n19 × 23 = 437";
	expect(stripReasoningTags(input)).toBe("19 × 23 = 437");
});

test("stripReasoningTags handles the exact 9router leak from the screenshot", () => {
	// 9router inlined reasoning as a literal text tag, then the answer.
	const input = "<thinking>\n19 * 23 = 437\n</thinking>\n\n19 × 23 = 437";
	expect(stripReasoningTags(input)).toBe("19 × 23 = 437");
});

test("stripReasoningTags drops a dangling unclosed thinking tag", () => {
	const input = "preamble <thinking>reasoning that never closes";
	expect(stripReasoningTags(input)).toBe("preamble");
});

test("stripReasoningTags is case-insensitive and handles <think>", () => {
	expect(stripReasoningTags("<THINK>hmm</THINK>answer")).toBe("answer");
	expect(stripReasoningTags("<think>hmm</think>answer")).toBe("answer");
});

test("stripReasoningTags leaves normal text untouched", () => {
	expect(stripReasoningTags("just a normal answer")).toBe("just a normal answer");
});

test("stripReasoningTags removes multiple thinking blocks", () => {
	const input = "<thinking>a</thinking>first<thinking>b</thinking>second";
	expect(stripReasoningTags(input)).toBe("firstsecond");
});

test("getAgentMessageText strips leaked thinking tags from text blocks", () => {
	const msg: AgentMessageLike = {
		role: "assistant",
		content: [{ type: "text", text: "<thinking>\n19 * 23 = 437\n</thinking>\n\n19 × 23 = 437" }],
	};
	expect(getAgentMessageText(msg)).toBe("19 × 23 = 437");
});

