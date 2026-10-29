import { describe, test, expect } from "bun:test";
import { TypingIndicator, type TypingDeps } from "../src/telegram/typing.js";

/** Minimal fake that records sendChatAction calls and drives timers. */
function createFakeDeps() {
	const calls: Array<{ chatId: number; action: string }> = [];
	let cb: (() => void) | undefined;

	const deps: TypingDeps = {
		sendChatAction: async (opts) => {
			calls.push({ chatId: opts.chatId, action: opts.action });
		},
		setInterval: (fn: () => void) => {
			cb = fn;

			return 1 as unknown as number;
		},
		clearInterval: () => {
			cb = undefined;
		},
	};

	return {
		deps,
		calls,
		tick: () => cb?.(),
	};
}

describe("TypingIndicator", () => {
	test("start sends typing action immediately", async () => {
		const { deps, calls } = createFakeDeps();
		const indicator = new TypingIndicator(42, deps);

		indicator.start();
		// Allow the async sendChatAction to resolve
		await new Promise((r) => setTimeout(r, 0));

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ chatId: 42, action: "typing" });
	});

	test("re-sends typing at each interval tick", async () => {
		const { deps, calls, tick } = createFakeDeps();
		const indicator = new TypingIndicator(42, deps);

		indicator.start();
		await new Promise((r) => setTimeout(r, 0));

		// Simulate two interval ticks
		tick();
		await new Promise((r) => setTimeout(r, 0));
		tick();
		await new Promise((r) => setTimeout(r, 0));

		expect(calls).toHaveLength(3); // 1 immediate + 2 ticks
		expect(calls.every((c) => c.action === "typing" && c.chatId === 42)).toBe(true);
	});

	test("stop prevents further interval sends", async () => {
		const { deps, calls, tick } = createFakeDeps();
		const indicator = new TypingIndicator(42, deps);

		indicator.start();
		await new Promise((r) => setTimeout(r, 0));
		expect(calls).toHaveLength(1);

		indicator.stop();
		tick(); // after stop, this should not fire
		await new Promise((r) => setTimeout(r, 0));

		expect(calls).toHaveLength(1); // still just the initial send
	});

	test("stop is idempotent — calling twice does not throw", () => {
		const { deps } = createFakeDeps();
		const indicator = new TypingIndicator(42, deps);

		indicator.stop(); // stop before start — should not throw
		indicator.start();
		indicator.stop();
		indicator.stop(); // double stop — should not throw
	});

	test("transport error is swallowed — does not throw", async () => {
		const calls: Array<{ chatId: number; action: string }> = [];

		const deps: TypingDeps = {
			sendChatAction: async () => {
				throw new Error("network down");
			},
			setInterval: (fn: () => void) => {
				// store but we won't tick
				return 1 as unknown as ReturnType<typeof globalThis.setInterval>;
			},
			clearInterval: () => {},
		};

		const indicator = new TypingIndicator(42, deps);

		// start should not throw even though sendChatAction rejects
		expect(() => indicator.start()).not.toThrow();
		// Let the microtask settle
		await new Promise((r) => setTimeout(r, 10));
	});
});
