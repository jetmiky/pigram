import { describe, test, expect, beforeEach } from "bun:test";
import { DialogManager } from "../src/telegram/dialog.js";
import type {
	TelegramCallbackQuery,
	TelegramUser,
	TelegramChat,
	TelegramMessage,
} from "../src/telegram/transport.js";

/**
 * Fake transport that records all calls.
 */
class FakeTransport {
	sendMessageCalls: Array<{
		chatId: number;
		text: string;
		parseMode?: "HTML";
		replyMarkup?: unknown;
	}> = [];

	editMessageTextCalls: Array<{
		chatId: number;
		messageId: number;
		text: string;
		parseMode?: "HTML";
		replyMarkup?: unknown;
	}> = [];

	answerCallbackQueryCalls: Array<{
		callbackQueryId: string;
		text?: string;
	}> = [];

	async sendMessage(opts: {
		chatId: number;
		text: string;
		parseMode?: "HTML";
		replyMarkup?: unknown;
	}): Promise<{ message_id: number }> {
		this.sendMessageCalls.push(opts);
		return { message_id: 1 };
	}

	async editMessageText(opts: {
		chatId: number;
		messageId: number;
		text: string;
		parseMode?: "HTML";
		replyMarkup?: unknown;
	}): Promise<void> {
		this.editMessageTextCalls.push(opts);
	}

	async answerCallbackQuery(opts: { callbackQueryId: string; text?: string }): Promise<void> {
		this.answerCallbackQueryCalls.push(opts);
	}

	reset(): void {
		this.sendMessageCalls = [];
		this.editMessageTextCalls = [];
		this.answerCallbackQueryCalls = [];
	}
}

/**
 * Deterministic ID generator for tests.
 */
function makeIdGen(): () => string {
	let counter = 0;
	return () => `d${++counter}`;
}

/**
 * Create a test callback query.
 */
function makeCallbackQuery(data: string, queryId = "q1"): TelegramCallbackQuery {
	const user: TelegramUser = {
		id: 123,
		is_bot: false,
		first_name: "Test",
	};

	const chat: TelegramChat = {
		id: 456,
		type: "private",
	};

	const message: TelegramMessage = {
		message_id: 1,
		date: Date.now(),
		chat,
	};

	return {
		id: queryId,
		from: user,
		message,
		data,
	};
}

describe("DialogManager", () => {
	let transport: FakeTransport;
	let manager: DialogManager;
	let idGen: () => string;

	beforeEach(() => {
		transport = new FakeTransport();
		idGen = makeIdGen();
		manager = new DialogManager({
			transport,
			chatId: 456,
			idGen,
		});
	});

	describe("select", () => {
		test("sends message with inline keyboard buttons", async () => {
			const promise = manager.select("Choose color:", [
				{ label: "Red", value: "red" },
				{ label: "Blue", value: "blue" },
				{ label: "Green", value: "green" },
			]);

			// Should have sent a message
			expect(transport.sendMessageCalls).toHaveLength(1);
			const call = transport.sendMessageCalls[0];
			expect(call?.chatId).toBe(456);
			expect(call?.text).toBe("Choose color:");

			// Check the inline keyboard structure
			const replyMarkup = call?.replyMarkup as {
				inline_keyboard?: Array<Array<{ text: string; callback_data: string }>>;
			};
			expect(replyMarkup.inline_keyboard).toHaveLength(3);
			expect(replyMarkup.inline_keyboard?.[0]?.[0]).toEqual({
				text: "Red",
				callback_data: "d1:0",
			});
			expect(replyMarkup.inline_keyboard?.[1]?.[0]).toEqual({
				text: "Blue",
				callback_data: "d1:1",
			});
			expect(replyMarkup.inline_keyboard?.[2]?.[0]).toEqual({
				text: "Green",
				callback_data: "d1:2",
			});

			// Simulate user clicking "Blue"
			const handled = await manager.handleCallbackQuery(makeCallbackQuery("d1:1"));
			expect(handled).toBe(true);

			// Promise should resolve with the value
			const result = await promise;
			expect(result).toBe("blue");

			// Should have answered the callback query
			expect(transport.answerCallbackQueryCalls).toHaveLength(1);
			expect(transport.answerCallbackQueryCalls[0]?.callbackQueryId).toBe("q1");

			// Should have edited the message to show the chosen option
			expect(transport.editMessageTextCalls).toHaveLength(1);
			const editCall = transport.editMessageTextCalls[0];
			expect(editCall?.chatId).toBe(456);
			expect(editCall?.messageId).toBe(1);
			expect(editCall?.text).toBe("Choose color:\n✓ Blue");
			expect(editCall?.replyMarkup).toEqual({ inline_keyboard: [] });
		});

		test("returns false for unknown callback data", async () => {
			const promise = manager.select("Pick one:", [
				{ label: "A", value: "a" },
				{ label: "B", value: "b" },
			]);

			// Simulate callback with wrong dialog ID
			const handled = await manager.handleCallbackQuery(makeCallbackQuery("d99:0"));
			expect(handled).toBe(false);

			// Promise should still be pending
			expect(transport.answerCallbackQueryCalls).toHaveLength(0);
			expect(transport.editMessageTextCalls).toHaveLength(0);

			// Now send the correct callback
			await manager.handleCallbackQuery(makeCallbackQuery("d1:0"));
			const result = await promise;
			expect(result).toBe("a");
		});

		test("does not resolve on text input", async () => {
			const promise = manager.select("Choose:", [{ label: "X", value: "x" }]);

			// Simulate text input
			const handled = manager.handleText("some text");
			expect(handled).toBe(false);

			// Promise should still be pending
			expect(transport.editMessageTextCalls).toHaveLength(0);

			// Resolve with callback
			await manager.handleCallbackQuery(makeCallbackQuery("d1:0"));
			const result = await promise;
			expect(result).toBe("x");
		});
	});

	describe("confirm", () => {
		test("sends yes/no buttons and resolves to boolean", async () => {
			const promise = manager.confirm("Delete file?");

			// Should have sent a message with two buttons
			expect(transport.sendMessageCalls).toHaveLength(1);
			const call = transport.sendMessageCalls[0];
			expect(call?.text).toBe("Delete file?");

			const replyMarkup = call?.replyMarkup as {
				inline_keyboard?: Array<Array<{ text: string; callback_data: string }>>;
			};
			expect(replyMarkup.inline_keyboard).toHaveLength(2);
			expect(replyMarkup.inline_keyboard?.[0]?.[0]?.text).toBe("Yes");
			expect(replyMarkup.inline_keyboard?.[1]?.[0]?.text).toBe("No");

			// Click "Yes"
			await manager.handleCallbackQuery(makeCallbackQuery("d1:0"));
			const result = await promise;
			expect(result).toBe(true);

			// Should have edited to show "Yes"
			const editCall = transport.editMessageTextCalls[0];
			expect(editCall?.text).toBe("Delete file?\n✓ Yes");
		});

		test("resolves to false when No is clicked", async () => {
			const promise = manager.confirm("Continue?");

			// Click "No"
			await manager.handleCallbackQuery(makeCallbackQuery("d1:1"));
			const result = await promise;
			expect(result).toBe(false);

			// Should have edited to show "No"
			const editCall = transport.editMessageTextCalls[0];
			expect(editCall?.text).toBe("Continue?\n✓ No");
		});
	});

	describe("textInput", () => {
		test("sends prompt and resolves with next text", async () => {
			const promise = manager.textInput("Enter your name:");

			// Should have sent a message without keyboard
			expect(transport.sendMessageCalls).toHaveLength(1);
			const call = transport.sendMessageCalls[0];
			expect(call?.text).toBe("Enter your name:");
			expect(call?.replyMarkup).toBeUndefined();

			// Simulate text input
			const handled = manager.handleText("Alice");
			expect(handled).toBe(true);

			// Promise should resolve
			const result = await promise;
			expect(result).toBe("Alice");

			// No edit or callback query should have happened
			expect(transport.editMessageTextCalls).toHaveLength(0);
			expect(transport.answerCallbackQueryCalls).toHaveLength(0);
		});

		test("does not resolve on callback query", async () => {
			const promise = manager.textInput("Enter value:");

			// Simulate callback query
			const handled = await manager.handleCallbackQuery(makeCallbackQuery("d1:0"));
			expect(handled).toBe(false);

			// Promise should still be pending
			expect(transport.answerCallbackQueryCalls).toHaveLength(0);

			// Now send text
			manager.handleText("test value");
			const result = await promise;
			expect(result).toBe("test value");
		});

		test("returns false for text when no textInput is pending", async () => {
			// No dialog active
			const handled = manager.handleText("random text");
			expect(handled).toBe(false);
		});
	});

	describe("multiple dialogs", () => {
		test("handles sequential dialogs with different IDs", async () => {
			// First dialog
			const promise1 = manager.select("First:", [{ label: "A", value: "a" }]);
			expect(transport.sendMessageCalls[0]?.replyMarkup).toMatchObject({
				inline_keyboard: [[{ callback_data: "d1:0" }]],
			});

			await manager.handleCallbackQuery(makeCallbackQuery("d1:0"));
			const result1 = await promise1;
			expect(result1).toBe("a");

			transport.reset();

			// Second dialog
			const promise2 = manager.select("Second:", [{ label: "B", value: "b" }]);
			expect(transport.sendMessageCalls[0]?.replyMarkup).toMatchObject({
				inline_keyboard: [[{ callback_data: "d2:0" }]],
			});

			await manager.handleCallbackQuery(makeCallbackQuery("d2:0"));
			const result2 = await promise2;
			expect(result2).toBe("b");
		});
	});

	describe("timeout", () => {
		test("rejects promise after timeout", async () => {
			const managerWithTimeout = new DialogManager({
				transport,
				chatId: 456,
				idGen,
				timeoutMs: 50,
			});

			const promise = managerWithTimeout.select("Choose:", [
				{ label: "X", value: "x" },
			]);

			// Promise should reject after timeout
			await expect(promise).rejects.toThrow("Dialog timed out");

			// After timeout, the callback should not be handled
			const handled = await managerWithTimeout.handleCallbackQuery(
				makeCallbackQuery("d1:0"),
			);
			expect(handled).toBe(false);
		});
	});
});
