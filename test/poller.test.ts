import { describe, test, expect, mock } from "bun:test";
import type { TelegramUpdate } from "../src/telegram/transport.js";
import { TelegramPoller, type UpdateHandler, type PollerDeps } from "../src/telegram/poller.js";

// Helper to yield control to event loop
const yield_tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("TelegramPoller", () => {
	test("processes a batch of updates", async () => {
		const updates: TelegramUpdate[] = [
			{ update_id: 100, message: { message_id: 1, date: 1, chat: { id: 1, type: "private" } } },
			{ update_id: 101, message: { message_id: 2, date: 2, chat: { id: 1, type: "private" } } },
		];

		let cursor = 99;
		const handlerCalls: number[] = [];
		const setCursorCalls: number[] = [];
		let callCount = 0;

		const transport = {
			getUpdates: mock(async (_opts: unknown, signal?: AbortSignal) => {
				// Yield to event loop to allow abort signal to propagate
				await yield_tick();
				
				callCount++;
				
				// Check if aborted
				if (signal?.aborted) {
					const err = new Error("The operation was aborted");
					err.name = "AbortError";
					throw err;
				}

				// Return updates once, then empty arrays
				if (callCount === 1) {
					return updates;
				}
				
				return [];
			}),
		};

		const handler: UpdateHandler = mock(async (update: TelegramUpdate) => {
			handlerCalls.push(update.update_id);
		});

		const getCursor = () => cursor;
		const setCursor = mock(async (updateId: number) => {
			setCursorCalls.push(updateId);
			cursor = updateId;
		});

		const controller = new AbortController();
		const poller = new TelegramPoller({
			transport,
			handler,
			getCursor,
			setCursor,
			pollTimeoutSeconds: 30,
			errorDelayMs: 0,
		});

		// Abort after a short delay to stop the loop
		setTimeout(() => controller.abort(), 50);

		await poller.start(controller.signal);

		// Handler should be called twice in order
		expect(handlerCalls).toEqual([100, 101]);

		// setCursor should be called with each update_id
		expect(setCursorCalls).toEqual([100, 101]);

		// Transport should have been called at least once
		expect(transport.getUpdates).toHaveBeenCalled();
	});

	test("advances offset based on cursor", async () => {
		let cursor = 99;
		const getUpdatesCalls: number[] = [];

		const transport = {
			getUpdates: mock(async (opts: { offset?: number; timeout?: number }, signal?: AbortSignal) => {
				// Yield to event loop
				await yield_tick();
				
				// Check if aborted
				if (signal?.aborted) {
					const err = new Error("The operation was aborted");
					err.name = "AbortError";
					throw err;
				}

				getUpdatesCalls.push(opts.offset ?? 0);

				// First call: return one update
				if (getUpdatesCalls.length === 1) {
					return [{ update_id: 100 }] as TelegramUpdate[];
				}

				// Second call: return another update
				if (getUpdatesCalls.length === 2) {
					return [{ update_id: 101 }] as TelegramUpdate[];
				}

				// Third call and onwards: return empty to avoid infinite loop
				return [];
			}),
		};

		const handler: UpdateHandler = mock(async () => {});

		const getCursor = () => cursor;
		const setCursor = mock(async (updateId: number) => {
			cursor = updateId;
		});

		const controller = new AbortController();
		const poller = new TelegramPoller({
			transport,
			handler,
			getCursor,
			setCursor,
			errorDelayMs: 0,
		});

		// Abort after a short delay
		setTimeout(() => controller.abort(), 100);

		await poller.start(controller.signal);

		// First call should use offset = 100 (cursor 99 + 1)
		expect(getUpdatesCalls[0]).toBe(100);

		// Second call should use offset = 101 (cursor 100 + 1)
		expect(getUpdatesCalls[1]).toBe(101);

		// Third call should use offset = 102 (cursor 101 + 1)
		expect(getUpdatesCalls[2]).toBe(102);
	});

	test("abort stops the loop cleanly", async () => {
		let callCount = 0;

		const transport = {
			getUpdates: mock(async (_opts: unknown, signal?: AbortSignal) => {
				// Yield to event loop
				await yield_tick();
				
				// Check if aborted
				if (signal?.aborted) {
					const err = new Error("The operation was aborted");
					err.name = "AbortError";
					throw err;
				}

				callCount++;

				// First call: return one update
				if (callCount === 1) {
					return [{ update_id: 100 }] as TelegramUpdate[];
				}

				// Subsequent calls: return empty
				return [];
			}),
		};

		let cursor = 99;
		const handler: UpdateHandler = mock(async () => {});
		const getCursor = () => cursor;
		const setCursor = mock(async (updateId: number) => {
			cursor = updateId;
		});

		const controller = new AbortController();
		const poller = new TelegramPoller({
			transport,
			handler,
			getCursor,
			setCursor,
			errorDelayMs: 0,
		});

		// Abort after first batch is processed
		setTimeout(() => controller.abort(), 50);

		// start() should resolve without throwing
		await expect(poller.start(controller.signal)).resolves.toBeUndefined();

		// Handler should have been called once
		expect(handler).toHaveBeenCalledTimes(1);
	});

	test("AbortError from getUpdates exits cleanly", async () => {
		const transport = {
			getUpdates: mock(async (_opts: unknown, signal?: AbortSignal) => {
				// Simulate an abort error
				const err = new Error("The operation was aborted");
				err.name = "AbortError";
				throw err;
			}),
		};

		let cursor = 99;
		const handler: UpdateHandler = mock(async () => {});
		const getCursor = () => cursor;
		const setCursor = mock(async () => {});
		const onError = mock(() => {});

		const controller = new AbortController();
		controller.abort(); // Pre-abort

		const poller = new TelegramPoller({
			transport,
			handler,
			getCursor,
			setCursor,
			onError,
			errorDelayMs: 0,
		});

		// start() should resolve without throwing
		await expect(poller.start(controller.signal)).resolves.toBeUndefined();

		// onError should not be called for AbortError
		expect(onError).not.toHaveBeenCalled();
	});

	test("non-abort error calls onError and continues", async () => {
		let callCount = 0;
		const errors: unknown[] = [];

		const transport = {
			getUpdates: mock(async (_opts: unknown, signal?: AbortSignal) => {
				// Yield to event loop
				await yield_tick();
				
				// Check if aborted
				if (signal?.aborted) {
					const err = new Error("The operation was aborted");
					err.name = "AbortError";
					throw err;
				}

				callCount++;

				// First call: throw an error
				if (callCount === 1) {
					throw new Error("Network failure");
				}

				// Second call: return an update
				if (callCount === 2) {
					return [{ update_id: 100 }] as TelegramUpdate[];
				}

				// Subsequent calls: return empty
				return [];
			}),
		};

		let cursor = 99;
		const handler: UpdateHandler = mock(async () => {});
		const getCursor = () => cursor;
		const setCursor = mock(async (updateId: number) => {
			cursor = updateId;
		});

		const onError = mock((err: unknown) => {
			errors.push(err);
		});

		const controller = new AbortController();
		const poller = new TelegramPoller({
			transport,
			handler,
			getCursor,
			setCursor,
			onError,
			errorDelayMs: 0,
		});

		// Abort after a delay to allow processing
		setTimeout(() => controller.abort(), 100);

		await poller.start(controller.signal);

		// onError should have been called once with the network error
		expect(onError).toHaveBeenCalledTimes(1);
		expect(errors.length).toBe(1);
		expect((errors[0] as Error).message).toBe("Network failure");

		// Handler should have been called once (for update 100)
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith({ update_id: 100 });
	});
});
