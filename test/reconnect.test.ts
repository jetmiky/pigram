import { describe, expect, test } from "bun:test";
import {
	findPendingReconnectRequest,
	formatNewSessionConfirmation,
	RECONNECT_CONSUMED_ENTRY_TYPE,
	RECONNECT_REQUEST_ENTRY_TYPE,
	type InspectableEntry,
	type ReconnectRequest,
} from "../src/domain/reconnect.js";

function requestEntry(req: ReconnectRequest): InspectableEntry {
	return { type: "custom", customType: RECONNECT_REQUEST_ENTRY_TYPE, data: req };
}

function consumedEntry(requestId: string): InspectableEntry {
	return { type: "custom", customType: RECONNECT_CONSUMED_ENTRY_TYPE, data: { requestId } };
}

describe("findPendingReconnectRequest", () => {
	test("returns a pending request", () => {
		const req: ReconnectRequest = { requestId: "r1", chatId: 42, sessionName: "feature" };
		const found = findPendingReconnectRequest([requestEntry(req)]);
		expect(found).toEqual(req);
	});

	test("ignores a request that has been consumed", () => {
		const req: ReconnectRequest = { requestId: "r1", chatId: 42 };
		const found = findPendingReconnectRequest([requestEntry(req), consumedEntry("r1")]);
		expect(found).toBeUndefined();
	});

	test("returns the newest pending request when several exist", () => {
		const older: ReconnectRequest = { requestId: "r1", chatId: 1 };
		const newer: ReconnectRequest = { requestId: "r2", chatId: 2 };
		const found = findPendingReconnectRequest([requestEntry(older), requestEntry(newer)]);
		expect(found).toEqual(newer);
	});

	test("skips consumed newest and falls back to an older pending one", () => {
		const older: ReconnectRequest = { requestId: "r1", chatId: 1 };
		const newer: ReconnectRequest = { requestId: "r2", chatId: 2 };
		const found = findPendingReconnectRequest([
			requestEntry(older),
			requestEntry(newer),
			consumedEntry("r2"),
		]);
		expect(found).toEqual(older);
	});

	test("ignores non-custom and unrelated entries", () => {
		const req: ReconnectRequest = { requestId: "r1", chatId: 42 };
		const found = findPendingReconnectRequest([
			{ type: "message" },
			{ type: "custom", customType: "something-else", data: { requestId: "x" } },
			requestEntry(req),
		]);
		expect(found).toEqual(req);
	});

	test("rejects malformed requests (missing chatId or id)", () => {
		expect(
			findPendingReconnectRequest([
				{ type: "custom", customType: RECONNECT_REQUEST_ENTRY_TYPE, data: { requestId: "r1" } },
			]),
		).toBeUndefined();
		expect(
			findPendingReconnectRequest([
				{ type: "custom", customType: RECONNECT_REQUEST_ENTRY_TYPE, data: { chatId: 1 } },
			]),
		).toBeUndefined();
	});

	test("returns undefined when there are no entries", () => {
		expect(findPendingReconnectRequest([])).toBeUndefined();
	});
});

describe("formatNewSessionConfirmation", () => {
	test("no name", () => {
		expect(formatNewSessionConfirmation({})).toBe("🆕 Started a fresh pi session");
	});

	test("with name", () => {
		expect(formatNewSessionConfirmation({ sessionName: "feature" })).toBe(
			"🆕 Started a fresh pi session: feature",
		);
	});

	test("with truncated name", () => {
		expect(formatNewSessionConfirmation({ sessionName: "feature", truncated: true })).toBe(
			"🆕 Started a fresh pi session: feature (name truncated)",
		);
	});
});
