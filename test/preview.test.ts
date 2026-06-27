import { describe, test, expect } from "bun:test";
import { PreviewSession, type PreviewTransport, type PreviewTimer } from "../src/telegram/preview.js";

interface Call {
	method: "sendMessage" | "editMessageText";
	text: string;
	messageId?: number;
	parseMode?: "HTML";
}

function fakeTransport(opts: { failHtml?: boolean } = {}) {
	const calls: Call[] = [];
	let nextId = 500;
	const transport: PreviewTransport = {
		async sendMessage(o) {
			if (opts.failHtml && o.parseMode === "HTML") throw new Error("Bad Request: can't parse entities");
			calls.push({ method: "sendMessage", text: o.text, parseMode: o.parseMode });
			return { message_id: nextId++ };
		},
		async editMessageText(o) {
			if (opts.failHtml && o.parseMode === "HTML") throw new Error("Bad Request: can't parse entities");
			calls.push({ method: "editMessageText", text: o.text, messageId: o.messageId, parseMode: o.parseMode });
		},
	};
	return { calls, transport };
}

/** A clock + timer pair under test control. The timer records the pending fn. */
function controllable() {
	let current = 0;
	let pending: (() => void) | undefined;
	const timer: PreviewTimer = {
		set(fn) {
			pending = fn;
		},
		clear() {
			pending = undefined;
		},
	};
	return {
		now: () => current,
		timer,
		advance(ms: number) {
			current += ms;
		},
		fireTimer() {
			const fn = pending;
			pending = undefined;
			fn?.();
		},
		hasPending() {
			return pending !== undefined;
		},
	};
}

describe("PreviewSession streaming", () => {
	test("first update sends a plain message immediately", async () => {
		const { calls, transport } = fakeTransport();
		const c = controllable();
		const s = new PreviewSession(1, { transport, now: c.now, timer: c.timer, throttleMs: 750 });

		await s.update("Hello");

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: "sendMessage", text: "Hello" });
		expect(calls[0]?.parseMode).toBeUndefined(); // streamed as PLAIN
	});

	test("rapid updates within the throttle window are coalesced", async () => {
		const { calls, transport } = fakeTransport();
		const c = controllable();
		const s = new PreviewSession(1, { transport, now: c.now, timer: c.timer, throttleMs: 750 });

		await s.update("a"); // flushes immediately (sendMessage)
		await s.update("ab"); // within window -> schedules trailing
		await s.update("abc"); // within window -> replaces trailing

		// Only the first flush has happened so far.
		expect(calls).toHaveLength(1);
		expect(c.hasPending()).toBe(true);

		// Advance past the window and fire the trailing flush.
		c.advance(750);
		c.fireTimer();
		await Promise.resolve();

		expect(calls).toHaveLength(2);
		expect(calls[1]).toMatchObject({ method: "editMessageText", text: "abc", messageId: 500 });
	});

	test("update after the window flushes immediately via edit", async () => {
		const { calls, transport } = fakeTransport();
		const c = controllable();
		const s = new PreviewSession(1, { transport, now: c.now, timer: c.timer, throttleMs: 750 });

		await s.update("first");
		c.advance(800);
		await s.update("second");

		expect(calls).toHaveLength(2);
		expect(calls[0]?.method).toBe("sendMessage");
		expect(calls[1]).toMatchObject({ method: "editMessageText", text: "second" });
	});

	test("identical consecutive text is skipped", async () => {
		const { calls, transport } = fakeTransport();
		const c = controllable();
		const s = new PreviewSession(1, { transport, now: c.now, timer: c.timer });

		await s.update("same");
		c.advance(800);
		await s.update("same");

		expect(calls).toHaveLength(1);
	});

	test("leaked thinking tags are stripped from previews", async () => {
		const { calls, transport } = fakeTransport();
		const c = controllable();
		const s = new PreviewSession(1, { transport, now: c.now, timer: c.timer });

		await s.update("<thinking>reasoning</thinking>\n\nThe answer");

		expect(calls).toHaveLength(1);
		expect(calls[0]?.text).toBe("The answer");
	});
});

describe("PreviewSession finalize", () => {
	test("edits the streamed message in place with rich HTML (no duplicate bubble)", async () => {
		const { calls, transport } = fakeTransport();
		const c = controllable();
		const s = new PreviewSession(1, { transport, now: c.now, timer: c.timer });

		await s.update("partial");
		await s.finalize("**done**");

		expect(calls).toHaveLength(2);
		expect(calls[0]?.method).toBe("sendMessage"); // the plain preview
		expect(calls[1]).toMatchObject({
			method: "editMessageText",
			text: "<b>done</b>",
			messageId: 500,
			parseMode: "HTML",
		});
	});

	test("with no prior updates, sends the final reply fresh as HTML", async () => {
		const { calls, transport } = fakeTransport();
		const c = controllable();
		const s = new PreviewSession(1, { transport, now: c.now, timer: c.timer });

		await s.finalize("*hi*");

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: "sendMessage", text: "<i>hi</i>", parseMode: "HTML" });
	});

	test("empty final text produces no message", async () => {
		const { calls, transport } = fakeTransport();
		const c = controllable();
		const s = new PreviewSession(1, { transport, now: c.now, timer: c.timer });

		await s.finalize("   ");

		expect(calls).toHaveLength(0);
	});

	test("updates after finalize are ignored", async () => {
		const { calls, transport } = fakeTransport();
		const c = controllable();
		const s = new PreviewSession(1, { transport, now: c.now, timer: c.timer });

		await s.finalize("done");
		const countAfterFinal = calls.length;
		await s.update("late token");

		expect(calls).toHaveLength(countAfterFinal);
	});

	test("finalize falls back to plain text when Telegram rejects HTML", async () => {
		const { calls, transport } = fakeTransport({ failHtml: true });
		const c = controllable();
		const s = new PreviewSession(1, { transport, now: c.now, timer: c.timer });

		await s.finalize("**bold**");

		// HTML send threw; a plain fallback send followed.
		const sends = calls.filter((x) => x.method === "sendMessage");
		expect(sends.length).toBeGreaterThanOrEqual(1);
		const last = sends[sends.length - 1]!;
		expect(last.parseMode).toBeUndefined();
		expect(last.text).toBe("bold"); // tags stripped in plain fallback
	});
});
