import { describe, test, expect } from "bun:test";
import type { TelegramCallbackQuery, TelegramTransport } from "../src/telegram/transport.js";
import {
	TelegramAskController,
	createTelegramAskTool,
	type TelegramAskToolParams,
} from "../src/telegram/ask.js";

class FakeTransport implements Pick<TelegramTransport, "sendMessage" | "editMessageText" | "answerCallbackQuery"> {
	sendMessageCalls: Array<{ chatId: number; text: string; replyMarkup?: unknown }> = [];
	editMessageTextCalls: Array<{ chatId: number; messageId: number; text: string; replyMarkup?: unknown }> = [];
	answerCallbackQueryCalls: Array<{ callbackQueryId: string; text?: string }> = [];
	failEdits = false;
	failSends = false;

	async sendMessage(opts: { chatId: number; text: string; replyMarkup?: unknown }) {
		this.sendMessageCalls.push(opts);
		if (this.failSends) throw new Error("send failed");
		return { message_id: 99 };
	}
	async editMessageText(opts: { chatId: number; messageId: number; text: string; replyMarkup?: unknown }) {
		this.editMessageTextCalls.push(opts);
		if (this.failEdits) throw new Error("edit failed");
	}
	async answerCallbackQuery(opts: { callbackQueryId: string; text?: string }) {
		this.answerCallbackQueryCalls.push(opts);
	}
}

function query(data: string, userId = 7, chatId = 42): TelegramCallbackQuery {
	return {
		id: `q-${data}`,
		from: { id: userId, is_bot: false, first_name: "User" },
		message: {
			message_id: 99,
			date: 1,
			chat: { id: chatId, type: "private" },
		},
		data,
	};
}

function runTool(controller: TelegramAskController, params: TelegramAskToolParams, signal?: AbortSignal) {
	const tool = createTelegramAskTool(controller);
	return tool.execute("call-1", params as never, signal, undefined, {} as never);
}

describe("telegram_ask extension tool boundary", () => {
	test("select returns the machine value and cleans up the keyboard", async () => {
		const transport = new FakeTransport();
		const controller = new TelegramAskController({ transport, idGen: () => "ask-1" });
		controller.beginTurn({ chatId: 42, userId: 7 });

		const pending = runTool(controller, {
			kind: "select",
			question: "Pick one",
			options: [{ label: "Friendly", value: "friendly" }],
		});
		expect(transport.sendMessageCalls[0]?.replyMarkup).toEqual({
			inline_keyboard: [[{ text: "Friendly", callback_data: "ask-1:0" }]],
		});

		await controller.handleCallbackQuery(query("ask-1:0"));
		const result = await pending;
		expect(result.details).toEqual({ status: "answered", value: "friendly" });
		expect(transport.editMessageTextCalls[0]?.text).toBe("Pick one\n✓ Friendly");
	});

	test("wrong user and wrong chat do not resolve; valid confirm No does", async () => {
		const transport = new FakeTransport();
		const controller = new TelegramAskController({ transport, idGen: () => "ask-2" });
		controller.beginTurn({ chatId: 42, userId: 7 });
		const pending = runTool(controller, { kind: "confirm", question: "Continue?" });

		await controller.handleCallbackQuery(query("ask-2:1", 8));
		await controller.handleCallbackQuery(query("ask-2:1", 7, 99));
		expect(transport.answerCallbackQueryCalls).toHaveLength(2);
		expect(await Promise.race([pending.then(() => "done"), Bun.sleep(5).then(() => "pending")])).toBe("pending");

		await controller.handleCallbackQuery(query("ask-2:1"));
		expect((await pending).details).toEqual({ status: "answered", value: false });
	});

	test("text answer does not copy the answer into the prompt", async () => {
		const transport = new FakeTransport();
		const controller = new TelegramAskController({ transport, idGen: () => "ask-3" });
		controller.beginTurn({ chatId: 42, userId: 7 });
		const pending = runTool(controller, { kind: "text", question: "What is your name?" });

		expect(controller.handleText("Alice", { chatId: 99, userId: 7 })).toBe(false);
		expect(controller.handleText("Alice", { chatId: 42, userId: 7 })).toBe(true);
		expect((await pending).details).toEqual({ status: "answered", value: "Alice" });
		expect(transport.editMessageTextCalls[0]?.text).toBe("What is your name?\n✓ Answer received");
	});

	test("terminal calls and a second pending call return structured unavailable outcomes", async () => {
		const transport = new FakeTransport();
		const controller = new TelegramAskController({ transport, idGen: () => "ask-4" });
		expect((await runTool(controller, { kind: "text", question: "No Telegram" })).details).toEqual({
			status: "unavailable",
			reason: "not_telegram_turn",
		});

		controller.beginTurn({ chatId: 42, userId: 7 });
		const first = runTool(controller, { kind: "text", question: "First" });
		expect((await runTool(controller, { kind: "text", question: "Second" })).details).toEqual({
			status: "unavailable",
			reason: "dialog_pending",
		});
		controller.cancel();
		expect((await first).details).toEqual({ status: "cancelled" });
	});

	test("abort and timeout settle with cleanup, and post-answer edit failure is non-fatal", async () => {
		const transport = new FakeTransport();
		const controller = new TelegramAskController({ transport, idGen: () => "ask-5", timeoutMs: 5 });
		controller.beginTurn({ chatId: 42, userId: 7 });
		const timed = runTool(controller, { kind: "select", question: "Wait", options: [{ label: "A", value: "a" }] });
		expect((await timed).details).toEqual({ status: "timeout" });
		expect(transport.editMessageTextCalls[0]?.text).toBe("Wait\n⌛ Timed out");

		controller.beginTurn({ chatId: 42, userId: 7 });
		transport.failEdits = true;
		const answered = runTool(controller, { kind: "confirm", question: "Sure?" });
		await controller.handleCallbackQuery(query("ask-5:0"));
		expect((await answered).details).toEqual({ status: "answered", value: true });

		controller.beginTurn({ chatId: 42, userId: 7 });
		const abort = new AbortController();
		const cancelled = runTool(controller, { kind: "text", question: "Cancel?" }, abort.signal);
		abort.abort();
		expect((await cancelled).details).toEqual({ status: "cancelled" });
	});

	test("malformed and stale callbacks are rejected without creating messages", async () => {
		const transport = new FakeTransport();
		const controller = new TelegramAskController({ transport, idGen: () => "ask-6" });
		controller.beginTurn({ chatId: 42, userId: 7 });
		expect(await controller.handleCallbackQuery(query("not-dialog-data"))).toBe(false);
		expect(await controller.handleCallbackQuery(query("old:0"))).toBe(true);
		expect(transport.answerCallbackQueryCalls[0]?.text).toBe("Dialog expired");
	});

	test("confirm Yes resolves to true", async () => {
		const transport = new FakeTransport();
		const controller = new TelegramAskController({ transport, idGen: () => "ask-7" });
		controller.beginTurn({ chatId: 42, userId: 7 });
		const pending = runTool(controller, { kind: "confirm", question: "Proceed?" });

		await controller.handleCallbackQuery(query("ask-7:0"));
		expect((await pending).details).toEqual({ status: "answered", value: true });
		expect(transport.editMessageTextCalls[0]?.text).toBe("Proceed?\n✓ Yes");
	});

	test("send failure surfaces as an operational tool error and settles state", async () => {
		const transport = new FakeTransport();
		const controller = new TelegramAskController({ transport, idGen: () => "ask-8" });
		controller.beginTurn({ chatId: 42, userId: 7 });
		transport.failSends = true;

		await expect(runTool(controller, { kind: "text", question: "Fail" })).rejects.toThrow("send failed");
		// The failed request must not remain pending: a follow-up dialog works.
		transport.failSends = false;
		const next = runTool(controller, { kind: "text", question: "After failure" });
		expect(controller.handleText("ok", { chatId: 42, userId: 7 })).toBe(true);
		expect((await next).details).toEqual({ status: "answered", value: "ok" });
	});

	test("parameter validation rejects invalid shapes at the tool boundary", async () => {
		const transport = new FakeTransport();
		const controller = new TelegramAskController({ transport, idGen: () => "ask-9" });
		controller.beginTurn({ chatId: 42, userId: 7 });

		await expect(runTool(controller, { kind: "select", question: "x", options: [] })).rejects.toThrow(
			"select requires at least one option",
		);
		await expect(
			runTool(controller, { kind: "confirm", question: "x", options: [{ label: "A", value: "a" }] } as never),
		).rejects.toThrow("confirm does not accept options");
		await expect(
			runTool(controller, { kind: "text", question: "x", timeoutSeconds: 5 } as never),
		).rejects.toThrow("timeoutSeconds must be between 15 and 900");
	});

	test("hasPendingText is true only while a text question waits", async () => {
		const transport = new FakeTransport();
		const controller = new TelegramAskController({ transport, idGen: () => "ask-10" });
		controller.beginTurn({ chatId: 42, userId: 7 });
		expect(controller.hasPendingText()).toBe(false);

		const text = runTool(controller, { kind: "text", question: "Name?" });
		expect(controller.hasPendingText()).toBe(true);
		expect(controller.handleText("Alice", { chatId: 42, userId: 7 })).toBe(true);
		await text;
		expect(controller.hasPendingText()).toBe(false);

		runTool(controller, { kind: "select", question: "Pick", options: [{ label: "A", value: "a" }] });
		// A select question is pending, but not a text question.
		expect(controller.hasPendingText()).toBe(false);
	});
});
