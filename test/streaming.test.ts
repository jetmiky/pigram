import { describe, test, expect } from "bun:test";
import { PreviewStreamer, type PreviewStreamerDeps, type DraftSender } from "../src/telegram/streaming";

/**
 * Fake transport that records all calls for inspection.
 */
interface TransportCall {
	method: "sendMessage" | "editMessageText";
	args: { chatId: number; text: string; messageId?: number };
}

function createFakeTransport() {
	const calls: TransportCall[] = [];
	let nextMessageId = 1000;

	return {
		calls,
		transport: {
			async sendMessage(opts: { chatId: number; text: string }) {
				const messageId = nextMessageId++;
				calls.push({ method: "sendMessage", args: { chatId: opts.chatId, text: opts.text } });
				return { message_id: messageId };
			},
			async editMessageText(opts: { chatId: number; messageId: number; text: string }) {
				calls.push({
					method: "editMessageText",
					args: { chatId: opts.chatId, messageId: opts.messageId, text: opts.text },
				});
			},
		},
		reset() {
			calls.length = 0;
		},
	};
}

/**
 * Controllable fake draft sender.
 */
function createFakeDraftSender(opts: { shouldThrow?: boolean } = {}) {
	const calls: Array<{ chatId: number; draftId: number; text: string }> = [];
	let shouldThrow = opts.shouldThrow ?? false;

	const sender: DraftSender = async (args) => {
		calls.push(args);
		if (shouldThrow) {
			throw new Error("Draft not supported");
		}
	};

	return {
		calls,
		sender,
		setShouldThrow(value: boolean) {
			shouldThrow = value;
		},
	};
}

describe("PreviewStreamer", () => {
	describe("when previews disabled (enabled=false)", () => {
		test("update() does not call any transport methods", async () => {
			const fake = createFakeTransport();
			const streamer = new PreviewStreamer(123, {
				transport: fake.transport,
				enabled: false,
			});

			await streamer.update("partial text 1");
			await streamer.update("partial text 2");

			expect(fake.calls).toHaveLength(0);
		});

		test("finalize() returns sent:false without calling transport", async () => {
			const fake = createFakeTransport();
			const streamer = new PreviewStreamer(123, {
				transport: fake.transport,
				enabled: false,
			});

			await streamer.update("partial text");
			const result = await streamer.finalize("final text");

			expect(result.sent).toBe(false);
			expect(fake.calls).toHaveLength(0);
		});

		test("clear() is a no-op without errors", async () => {
			const fake = createFakeTransport();
			const streamer = new PreviewStreamer(123, {
				transport: fake.transport,
				enabled: false,
			});

			await streamer.update("some text");
			await streamer.clear();

			expect(fake.calls).toHaveLength(0);
		});
	});

	describe("when draft sender provided and working", () => {
		test("update() uses sendDraft repeatedly with stable draftId", async () => {
			const fake = createFakeTransport();
			const draft = createFakeDraftSender();
			const streamer = new PreviewStreamer(123, {
				transport: fake.transport,
				sendDraft: draft.sender,
				enabled: true,
			});

			await streamer.update("partial 1");
			await streamer.update("partial 2");
			await streamer.update("partial 3");

			// All draft calls
			expect(draft.calls).toHaveLength(3);
			expect(draft.calls[0]).toMatchObject({ chatId: 123, text: "partial 1" });
			expect(draft.calls[1]).toMatchObject({ chatId: 123, text: "partial 2" });
			expect(draft.calls[2]).toMatchObject({ chatId: 123, text: "partial 3" });

			// Same draftId for all
			const draftIds = draft.calls.map((c) => c.draftId);
			expect(draftIds[0]).toBe(draftIds[1]);
			expect(draftIds[1]).toBe(draftIds[2]);

			// No message-mode calls
			expect(fake.calls).toHaveLength(0);
		});

		test("finalize() sends a real message (drafts are ephemeral)", async () => {
			const fake = createFakeTransport();
			const draft = createFakeDraftSender();
			const streamer = new PreviewStreamer(123, {
				transport: fake.transport,
				sendDraft: draft.sender,
				enabled: true,
			});

			await streamer.update("partial 1");
			await streamer.update("partial 2");
			const result = await streamer.finalize("final text");

			// Draft calls during updates
			expect(draft.calls).toHaveLength(2);

			// Final real message
			expect(fake.calls).toHaveLength(1);
			expect(fake.calls[0]).toMatchObject({
				method: "sendMessage",
				args: { chatId: 123, text: "final text" },
			});

			expect(result.sent).toBe(true);
			expect(result.messageId).toBe(1000);
		});

		test("update() trims text and skips empty strings", async () => {
			const fake = createFakeTransport();
			const draft = createFakeDraftSender();
			const streamer = new PreviewStreamer(123, {
				transport: fake.transport,
				sendDraft: draft.sender,
				enabled: true,
			});

			await streamer.update("  ");
			await streamer.update("");
			await streamer.update("valid text");

			// Only one call for valid text
			expect(draft.calls).toHaveLength(1);
			expect(draft.calls[0]?.text).toBe("valid text");
		});

		test("update() deduplicates identical consecutive text", async () => {
			const fake = createFakeTransport();
			const draft = createFakeDraftSender();
			const streamer = new PreviewStreamer(123, {
				transport: fake.transport,
				sendDraft: draft.sender,
				enabled: true,
			});

			await streamer.update("same text");
			await streamer.update("same text");
			await streamer.update("different text");
			await streamer.update("different text");

			// Only unique texts sent
			expect(draft.calls).toHaveLength(2);
			expect(draft.calls[0]?.text).toBe("same text");
			expect(draft.calls[1]?.text).toBe("different text");
		});
	});

	describe("when draft sender throws on first use", () => {
		test("permanently falls back to message mode", async () => {
			const fake = createFakeTransport();
			const draft = createFakeDraftSender({ shouldThrow: true });
			const streamer = new PreviewStreamer(123, {
				transport: fake.transport,
				sendDraft: draft.sender,
				enabled: true,
			});

			await streamer.update("partial 1");
			await streamer.update("partial 2");
			await streamer.update("partial 3");

			// First update tried draft and failed
			expect(draft.calls).toHaveLength(1);

			// Fell back to message mode: sendMessage once, then editMessageText
			expect(fake.calls).toHaveLength(3);
			expect(fake.calls[0]?.method).toBe("sendMessage");
			expect(fake.calls[0]?.args.text).toBe("partial 1");
			expect(fake.calls[1]?.method).toBe("editMessageText");
			expect(fake.calls[1]?.args.text).toBe("partial 2");
			expect(fake.calls[2]?.method).toBe("editMessageText");
			expect(fake.calls[2]?.args.text).toBe("partial 3");
		});

		test("finalize() edits the existing message (no duplicate send)", async () => {
			const fake = createFakeTransport();
			const draft = createFakeDraftSender({ shouldThrow: true });
			const streamer = new PreviewStreamer(123, {
				transport: fake.transport,
				sendDraft: draft.sender,
				enabled: true,
			});

			await streamer.update("partial 1");
			await streamer.update("partial 2");
			fake.reset(); // Clear previous calls for clarity

			const result = await streamer.finalize("final text");

			// Should edit the existing message, not send a new one
			expect(fake.calls).toHaveLength(1);
			expect(fake.calls[0]?.method).toBe("editMessageText");
			expect(fake.calls[0]?.args.text).toBe("final text");
			expect(fake.calls[0]?.args.messageId).toBe(1000);

			expect(result.sent).toBe(true);
		});
	});

	describe("when no draft sender provided", () => {
		test("uses message mode from the start", async () => {
			const fake = createFakeTransport();
			const streamer = new PreviewStreamer(123, {
				transport: fake.transport,
				// no sendDraft
				enabled: true,
			});

			await streamer.update("partial 1");
			await streamer.update("partial 2");
			await streamer.update("partial 3");

			// Message mode: sendMessage once, then editMessageText
			expect(fake.calls).toHaveLength(3);
			expect(fake.calls[0]?.method).toBe("sendMessage");
			expect(fake.calls[0]?.args.text).toBe("partial 1");
			expect(fake.calls[1]?.method).toBe("editMessageText");
			expect(fake.calls[1]?.args.text).toBe("partial 2");
			expect(fake.calls[2]?.method).toBe("editMessageText");
			expect(fake.calls[2]?.args.text).toBe("partial 3");
		});

		test("finalize() edits the existing message", async () => {
			const fake = createFakeTransport();
			const streamer = new PreviewStreamer(123, {
				transport: fake.transport,
				enabled: true,
			});

			await streamer.update("partial 1");
			fake.reset();

			const result = await streamer.finalize("final text");

			expect(fake.calls).toHaveLength(1);
			expect(fake.calls[0]?.method).toBe("editMessageText");
			expect(fake.calls[0]?.args.text).toBe("final text");

			expect(result.sent).toBe(true);
		});

		test("finalize() sends new message if no updates were sent", async () => {
			const fake = createFakeTransport();
			const streamer = new PreviewStreamer(123, {
				transport: fake.transport,
				enabled: true,
			});

			// finalize without any prior updates
			const result = await streamer.finalize("final text");

			expect(fake.calls).toHaveLength(1);
			expect(fake.calls[0]?.method).toBe("sendMessage");
			expect(fake.calls[0]?.args.text).toBe("final text");

			expect(result.sent).toBe(true);
			expect(result.messageId).toBe(1000);
		});
	});

	describe("edge cases", () => {
		test("finalize() with empty text returns sent:false", async () => {
			const fake = createFakeTransport();
			const streamer = new PreviewStreamer(123, {
				transport: fake.transport,
				enabled: true,
			});

			await streamer.update("some text");
			fake.reset();

			const result = await streamer.finalize("   ");

			expect(result.sent).toBe(false);
			expect(fake.calls).toHaveLength(0);
		});

		test("clear() resets state for subsequent updates", async () => {
			const fake = createFakeTransport();
			const draft = createFakeDraftSender();
			const streamer = new PreviewStreamer(123, {
				transport: fake.transport,
				sendDraft: draft.sender,
				enabled: true,
			});

			await streamer.update("first batch");
			await streamer.clear();
			await streamer.update("second batch");

			// Two draft calls (clear doesn't delete draft, just resets state)
			expect(draft.calls).toHaveLength(2);
			// After clear, deduplication state is reset
			expect(draft.calls[1]?.text).toBe("second batch");
		});

		test("update() with whitespace-only text is skipped", async () => {
			const fake = createFakeTransport();
			const streamer = new PreviewStreamer(123, {
				transport: fake.transport,
				enabled: true,
			});

			await streamer.update("\n\t  \n");

			expect(fake.calls).toHaveLength(0);
		});

		test("text is trimmed before deduplication check", async () => {
			const fake = createFakeTransport();
			const draft = createFakeDraftSender();
			const streamer = new PreviewStreamer(123, {
				transport: fake.transport,
				sendDraft: draft.sender,
				enabled: true,
			});

			await streamer.update("  text  ");
			await streamer.update("text");
			await streamer.update("  text");

			// All should be deduplicated to one call
			expect(draft.calls).toHaveLength(1);
			expect(draft.calls[0]?.text).toBe("text");
		});
	});
});
