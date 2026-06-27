import { describe, expect, test } from "bun:test";
import { createHttpTransport, type TelegramTransport } from "../src/telegram/transport";
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

	async lastBodyAsJson(): Promise<unknown> {
		const last = this.lastCall();
		if (!last?.init?.body) return null;
		if (typeof last.init.body === "string") {
			return JSON.parse(last.init.body);
		}
		return null;
	}
}

describe("TelegramTransport", () => {
	const TOKEN = "test-bot-token";

	test("getMe builds correct URL and parses result", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({
			ok: true,
			result: { id: 123, username: "testbot", is_bot: true, first_name: "Test" },
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

		const body = await fake.lastBodyAsJson();
		expect(body).toEqual({ offset: 100, timeout: 30 });
	});

	test("getUpdates accepts AbortSignal", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result: [] });

		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });
		const controller = new AbortController();
		await transport.getUpdates({ offset: 1 }, controller.signal);

		const call = fake.lastCall();
		expect(call.init?.signal).toBe(controller.signal);
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

		const body = await fake.lastBodyAsJson();
		expect(body).toEqual({
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

		const body = await fake.lastBodyAsJson();
		expect(body).toEqual({ chat_id: 333, text: "plain" });
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

		const body = await fake.lastBodyAsJson();
		expect(body).toEqual({
			chat_id: 444,
			message_id: 555,
			text: "edited",
			parse_mode: "HTML",
		});

		const call = fake.lastCall();
		expect(call.url).toBe(`https://api.telegram.org/bot${TOKEN}/editMessageText`);
	});

	test("sendChatAction posts action with snake_case", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result: true });

		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });
		await transport.sendChatAction({ chatId: 666, action: "typing" });

		const body = await fake.lastBodyAsJson();
		expect(body).toEqual({ chat_id: 666, action: "typing" });
	});

	test("answerCallbackQuery maps callbackQueryId to callback_query_id", async () => {
		const fake = new FakeFetch();
		fake.queueResponse({ ok: true, result: true });

		const transport = createHttpTransport({ botToken: TOKEN, fetchImpl: fake.fetch });
		await transport.answerCallbackQuery({ callbackQueryId: "cb-123", text: "acknowledged" });

		const body = await fake.lastBodyAsJson();
		expect(body).toEqual({ callback_query_id: "cb-123", text: "acknowledged" });
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
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("downloadFile calls getFile then downloads to destPath", async () => {
		const fake = new FakeFetch();
		// First call: getFile
		fake.queueResponse({
			ok: true,
			result: { file_id: "file-123", file_path: "documents/file.pdf", file_size: 100 },
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
