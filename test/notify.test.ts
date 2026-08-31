import { describe, expect, test } from "bun:test";
import {
	consumePendingNotify,
	parseNotifyArgs,
	NOTIFY_USAGE_MESSAGE,
	resolveNotifyRequest,
	type PendingNotify,
} from "../src/domain/notify.js";

describe("parseNotifyArgs", () => {
	test("defaults to one-shot mode with no args", () => {
		expect(parseNotifyArgs("")).toEqual({ ok: true, mode: "once" });
		expect(parseNotifyArgs("   ")).toEqual({ ok: true, mode: "once" });
	});

	test("parses on as sticky mode", () => {
		expect(parseNotifyArgs("on")).toEqual({ ok: true, mode: "sticky" });
	});

	test("parses off as disabling", () => {
		expect(parseNotifyArgs("off")).toEqual({ ok: true, mode: "off" });
	});

	test("is case-insensitive", () => {
		expect(parseNotifyArgs("ON")).toEqual({ ok: true, mode: "sticky" });
		expect(parseNotifyArgs("Off")).toEqual({ ok: true, mode: "off" });
	});

	test("trims whitespace around the argument", () => {
		expect(parseNotifyArgs("  on  ")).toEqual({ ok: true, mode: "sticky" });
		expect(parseNotifyArgs("\toff\n")).toEqual({ ok: true, mode: "off" });
	});

	test("rejects unknown arguments with a usage message", () => {
		const bad = parseNotifyArgs("maybe");
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.message).toBe(NOTIFY_USAGE_MESSAGE);
	});

	test("rejects extra arguments", () => {
		const bad = parseNotifyArgs("on now");
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.message).toBe(NOTIFY_USAGE_MESSAGE);
	});
});

describe("consumePendingNotify", () => {
	const once: PendingNotify = { mode: "once", chatId: 111 };
	const sticky: PendingNotify = { mode: "sticky", chatId: 222 };

	test("no pending request stays no pending request", () => {
		const result = consumePendingNotify(undefined, { text: "hi" });
		expect(result.deliver).toBeUndefined();
		expect(result.pending).toBeUndefined();
	});

	test("one-shot + text delivers and clears", () => {
		const result = consumePendingNotify(once, { text: "the answer" });
		expect(result.deliver).toEqual({ kind: "text", chatId: 111, markdown: "the answer" });
		expect(result.pending).toBeUndefined();
	});

	test("one-shot + error delivers an error line and clears", () => {
		const result = consumePendingNotify(once, { errorMessage: "boom" });
		expect(result.deliver).toEqual({ kind: "error", chatId: 111, line: "⚠️ boom" });
		expect(result.pending).toBeUndefined();
	});

	test("one-shot + aborted turn (no text, no error) stays armed", () => {
		const result = consumePendingNotify(once, {});
		expect(result.deliver).toBeUndefined();
		expect(result.pending).toEqual(once);
	});

	test("one-shot + empty reply (no text, no error) stays armed", () => {
		const result = consumePendingNotify(once, {});
		expect(result.deliver).toBeUndefined();
		expect(result.pending).toEqual(once);
	});

	test("sticky + text delivers and stays armed", () => {
		const result = consumePendingNotify(sticky, { text: "reply 1" });
		expect(result.deliver).toEqual({ kind: "text", chatId: 222, markdown: "reply 1" });
		expect(result.pending).toEqual(sticky);
	});

	test("sticky + aborted turn stays armed with nothing delivered", () => {
		const result = consumePendingNotify(sticky, {});
		expect(result.deliver).toBeUndefined();
		expect(result.pending).toEqual(sticky);
	});
});

describe("resolveNotifyRequest", () => {
	test("config all creates sticky delivery to the paired chat", () => {
		expect(resolveNotifyRequest(undefined, "all", 333)).toEqual({ mode: "sticky", chatId: 333 });
	});

	test("config off does not create a delivery request", () => {
		expect(resolveNotifyRequest(undefined, "off", 333)).toBeUndefined();
	});

	test("a session command override wins over config", () => {
		const once: PendingNotify = { mode: "once", chatId: 111 };
		expect(resolveNotifyRequest(once, "all", 333)).toEqual(once);
		expect(resolveNotifyRequest("off", "all", 333)).toBeUndefined();
	});

	test("config all remains inactive until a user has paired", () => {
		expect(resolveNotifyRequest(undefined, "all", undefined)).toBeUndefined();
	});
});
