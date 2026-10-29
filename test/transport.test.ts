import { describe, expect, test } from "bun:test";
import { createHttpTransport } from "../src/telegram/transport";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Fake fetch implementation that records calls and returns canned responses.
 */
class FakeFetch {
	calls: Array<{ url: string; init?: RequestInit }> = [];
	responses: Response[] = [];
	private responseIndex = 0;

	queueResponse(body: unknown, status = 200): void {
		this.responses.push(
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			}),
		);
	}

	queueBinaryResponse(buffer: Uint8Array, status = 200): void {
		this.responses.push(
			new Response(buffer, {
				status,
			}),
		);
	}

	fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
		this.calls.push({ url: url.toString(), init });

		if (this.responseIndex >= this.responses.length) {
			throw new Error("FakeFetch: no more queued responses");
		}

		return this.responses[this.responseIndex++];
	};

	lastCall() {
		return this.calls[this.calls.length - 1];
	}

	async expectLastBody<T>(expected: T): Promise<void> {
		const body = this.lastCall()?.init?.body;
		expect(await new Response(body).json()).toEqual(expected);
	}
}

describe("TelegramTransport", () => {
	const TOKEN = "test-bot-token";

	test("getMe builds correct URL and parses result", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({
			ok: true,
			result: { id: 123, username: "testbot", is_bot: true, first_name: "Test", can_join_groups: true },
		});

		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });
		const me = await transport.getMe();

		expect(me.id).toBe(123);
		expect(me.username).toBe("testbot");
		expect(me.is_bot).toBe(true);
		expect(me.first_name).toBe("Test");

		const call = fake.lastCall();
		expect(call.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
		expect(call.init?.method).toBe("POST");
	});

	test("getUpdates passes offset and timeout in body", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({
			ok: true,
			result: [
				{
					update_id: 456,
					message: {
						message_id: 789,
						from: { id: 111, is_bot: false, first_name: "Alice" },
						chat: { id: 222, type: "private" },
						date: 1609459200,
						text: "hello",
					},
				},
			],
		});

		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });
		const updates = await transport.getUpdates({ offset: 100, timeout: 30 });

		expect(updates.length).toBe(1);
		expect(updates[0]?.update_id).toBe(456);
		expect(updates[0]?.message?.text).toBe("hello");

		await fake.expectLastBody({
			offset: 100,
			timeout: 30,
			allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post", "callback_query"],
		});
	});

	test("getUpdates accepts callback queries with Telegram metadata", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({
			ok: true,
			result: [{
				update_id: 1,
				callback_query: {
					id: "q-1",
					from: { id: 7, is_bot: false, first_name: "User" },
					message: { message_id: 99, date: 1, chat: { id: 42, type: "private" } },
					chat_instance: "instance",
					data: "ask-1:0",
				},
			}],
		});
		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });

		expect((await transport.getUpdates({}))[0]?.callback_query?.data).toBe("ask-1:0");
	});

	test("getUpdates always pins allowed_updates including callback_query", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result: [] });

		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });
		await transport.getUpdates({ offset: 1 });

		await fake.expectLastBody(expect.objectContaining({
			allowed_updates: expect.arrayContaining(["callback_query", "message"]),
		}));
	});

	test("getUpdates aborts a request that outlives the server long-poll timeout", async () => {
		let requestSignal: AbortSignal | undefined;

		const fetchImpl = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestSignal = init?.signal ?? undefined;

			return new Promise((_resolve, reject) => {
				requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
			});
		};

		const transport = createHttpTransport({
			botToken: TOKEN,
			fetchImpl,
			getUpdatesTimeoutMarginMs: 10,
		});

		await expect(transport.getUpdates({ offset: 1, timeout: 0 })).rejects.toBeDefined();
		expect(requestSignal?.aborted).toBe(true);
	});

	test("getUpdates lifecycle cancellation aborts a pending request promptly", async () => {
		let requestSignal: AbortSignal | undefined;

		const fetchImpl = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestSignal = init?.signal ?? undefined;

			return new Promise((_resolve, reject) => {
				requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
			});
		};

		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl });
		const controller = new AbortController();
		const pending = transport.getUpdates({ offset: 1, timeout: 30 }, controller.signal);

		controller.abort();

		await expect(pending).rejects.toBeDefined();
		expect(requestSignal?.aborted).toBe(true);
	});

	test("getUpdates uses a request signal without replacing the lifecycle signal", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result: [] });

		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });
		const controller = new AbortController();
		await transport.getUpdates({ offset: 1 }, controller.signal);

		const call = fake.lastCall();
		expect(call.init?.signal).toBeInstanceOf(AbortSignal);
		expect(call.init?.signal).not.toBe(controller.signal);
		expect(call.init?.signal?.aborted).toBe(false);
	});

	test("sendMessage posts chat_id, text, parse_mode and returns message_id", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({
			ok: true,
			result: { message_id: 999 },
		});

		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });

		const result = await transport.sendMessage({
			chatId: 222,
			text: "Hello world",
			parseMode: "HTML",
		});

		expect(result.message_id).toBe(999);

		await fake.expectLastBody({
			chat_id: 222,
			text: "Hello world",
			parse_mode: "HTML",
		});
	});

	test("sendMessage omits optional fields when not provided", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result: { message_id: 111 } });

		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });
		await transport.sendMessage({ chatId: 333, text: "plain" });

		await fake.expectLastBody({ chat_id: 333, text: "plain" });
	});

	test("sendMessage preserves reply markup", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result: { message_id: 111 } });
		const replyMarkup = { inline_keyboard: [[{ text: "Yes", callback_data: "yes" }]] };
		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });

		await transport.sendMessage({ chatId: 333, text: "Choose", replyMarkup });

		await fake.expectLastBody({ chat_id: 333, text: "Choose", reply_markup: replyMarkup });
	});

	test("editMessageText maps messageId to message_id", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result: true });

		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });
		await transport.editMessageText({
			chatId: 444,
			messageId: 555,
			text: "edited",
			parseMode: "HTML",
		});

		await fake.expectLastBody({
			chat_id: 444,
			message_id: 555,
			text: "edited",
			parse_mode: "HTML",
		});

		const call = fake.lastCall();
		expect(call.url).toBe(`https://api.telegram.org/bot${TOKEN}/editMessageText`);
	});

	test("sendRichMessage posts raw markdown in rich_message", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result: { message_id: 777 } });

		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });

		const result = await transport.sendRichMessage({
			chatId: 444,
			markdown: "| A | B |\n|---|---|\n| 1 | 2 |",
		});

		expect(result.message_id).toBe(777);
		await fake.expectLastBody({
			chat_id: 444,
			rich_message: { markdown: "| A | B |\n|---|---|\n| 1 | 2 |" },
		});
		const call = fake.lastCall();
		expect(call.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendRichMessage`);
	});

	test("editMessageRich edits via editMessageText with rich_message", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result: true });

		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });
		await transport.editMessageRich({
			chatId: 444,
			messageId: 555,
			markdown: "| A |\n|---|\n| 1 |",
		});

		await fake.expectLastBody({
			chat_id: 444,
			message_id: 555,
			rich_message: { markdown: "| A |\n|---|\n| 1 |" },
		});
		const call = fake.lastCall();
		expect(call.url).toBe(`https://api.telegram.org/bot${TOKEN}/editMessageText`);
	});

	test("sendChatAction posts action with snake_case", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result: true });

		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });
		await transport.sendChatAction({ chatId: 666, action: "typing" });

		await fake.expectLastBody({ chat_id: 666, action: "typing" });
	});

	test("answerCallbackQuery maps callbackQueryId to callback_query_id", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result: true });

		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });
		await transport.answerCallbackQuery({ callbackQueryId: "cb-123", text: "acknowledged" });

		await fake.expectLastBody({ callback_query_id: "cb-123", text: "acknowledged" });
	});

	test.each([
		[null],
		[[]],
		[42],
		[{ ok: "true", result: {} }],
		[{ ok: true, description: 123, result: {} }],
	])("rejects malformed Telegram envelopes (%j)", async (payload) => {
		const fake = new FakeFetch();
		fake.queueResponse(payload);
		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });

		await expect(transport.getMe()).rejects.toThrow("Invalid Telegram API getMe response");
	});

	test.each([
		[null],
		[{}],
		[{ id: "123", is_bot: true, first_name: "Bot" }],
		[{ id: -1, is_bot: true, first_name: "Bot" }],
		[{ id: 123, is_bot: true, first_name: "Bot", username: 1 }],
	])("rejects malformed bot identities (%j)", async (result) => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result });
		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });

		await expect(transport.getMe()).rejects.toThrow("Invalid Telegram API getMe result");
	});

	test.each([
		{ result: [{ update_id: "1" }] },
		{ result: [{ update_id: -1 }] },
		{ result: [{ update_id: 1, message: { message_id: 1, date: 1, chat: { id: "42", type: "private" } } }] },
		{ result: [{ update_id: 1, callback_query: { id: "q", from: { id: "7", is_bot: false, first_name: "User" } } }] },
	])("rejects malformed update identities (%j)", async ({ result }) => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result });
		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });

		await expect(transport.getUpdates({})).rejects.toThrow("Invalid Telegram API getUpdates result");
	});

	test("rejects invalid JSON and multipart message IDs", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result: { message_id: "1" } });
		fake.queueResponse({ ok: true, result: {} });
		fake.queueResponse({ ok: false, description: "Upload rejected" });
		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });
		const upload = { chatId: 1, filePath: import.meta.filename, fileName: "fixture.ts" };

		await expect(transport.sendMessage({ chatId: 1, text: "test" })).rejects.toThrow("Invalid Telegram API sendMessage result");
		await expect(transport.sendDocument(upload)).rejects.toThrow("Invalid Telegram API sendDocument result");
		await expect(transport.sendDocument(upload)).rejects.toThrow("Upload rejected");
	});

	test("accepts a Message result when editing a regular chat message", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result: { message_id: 555, date: 1, chat: { id: 42, type: "private" } } });
		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });

		await expect(transport.editMessageText({ chatId: 42, messageId: 555, text: "edited" })).resolves.toBeUndefined();
	});

	test("rejects a false success result for chat actions", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result: false });
		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });

		await expect(transport.sendChatAction({ chatId: 42, action: "typing" })).rejects.toThrow("Invalid Telegram API sendChatAction result");
	});

	test("Telegram error response with description throws Error", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: false, description: "Bad Request: message text is empty" });

		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });

		await expect(transport.sendMessage({ chatId: 1, text: "" })).rejects.toThrow(
			"Bad Request: message text is empty",
		);
	});

	test("Telegram error response without description throws generic error", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: false });

		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });

		await expect(transport.getMe()).rejects.toThrow("Telegram API getMe failed");
	});

	test("Telegram response with ok:true but missing result throws error", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true });

		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });

		await expect(transport.getMe()).rejects.toThrow("Telegram API getMe failed");
	});

	test("sendDocument builds multipart request to sendDocument endpoint", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result: { message_id: 777 } });

		const tempDir = join(import.meta.dir, ".test-temp");
		await mkdir(tempDir, { recursive: true });
		const testFile = join(tempDir, "test.txt");
		await writeFile(testFile, "test content", "utf-8");

		try {
			const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });

			const result = await transport.sendDocument({
				chatId: 888,
				filePath: testFile,
				fileName: "test.txt",
				caption: "Test file",
			});

			expect(result.message_id).toBe(777);

			const call = fake.lastCall();
			expect(call.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendDocument`);
			expect(call.init?.method).toBe("POST");

			// Check that body is FormData (can't easily inspect contents in test)
			expect(call.init?.body).toBeInstanceOf(FormData);
			const form = call.init?.body;
			expect(form instanceof FormData && form.get("caption")).toBe("Test file");
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("sendPhoto builds multipart request to sendPhoto endpoint", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result: { message_id: 888 } });

		const tempDir = join(import.meta.dir, ".test-temp");
		await mkdir(tempDir, { recursive: true });
		const testFile = join(tempDir, "photo.jpg");
		await writeFile(testFile, Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // fake JPEG header

		try {
			const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });

			const result = await transport.sendPhoto({
				chatId: 999,
				filePath: testFile,
				fileName: "photo.jpg",
			});

			expect(result.message_id).toBe(888);

			const call = fake.lastCall();
			expect(call.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendPhoto`);
			expect(call.init?.body).toBeInstanceOf(FormData);
			const form = call.init?.body;
			expect(form instanceof FormData && form.has("caption")).toBe(false);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("downloadFile calls getFile then downloads to destPath", async () => {
		const fake = new FakeFetch();
		// First call: getFile
		fake.queueResponse({
			ok: true,
			result: { file_id: "file-123", file_unique_id: "unique-123", file_path: "documents/file.pdf", file_size: 100 },
		});
		// Second call: download file bytes
		fake.queueBinaryResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46])); // %PDF

		const tempDir = join(import.meta.dir, ".test-temp");
		await mkdir(tempDir, { recursive: true });
		const destPath = join(tempDir, "downloaded.pdf");

		try {
			const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });
			const resultPath = await transport.downloadFile({ fileId: "file-123", destPath });

			expect(resultPath).toBe(destPath);

			// Verify getFile was called
			const firstCall = fake.calls[0];
			expect(firstCall?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getFile`);

			// Verify file download URL
			const secondCall = fake.calls[1];
			expect(secondCall?.url).toBe(
				`https://api.telegram.org/file/bot${TOKEN}/documents/file.pdf`,
			);

			// Verify file was written
			const content = await readFile(destPath);
			expect(content[0]).toBe(0x25); // %
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});
