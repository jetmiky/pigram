import { describe, test, expect } from "bun:test";
import { containsGfmTable, isPermanentRichError, splitTableRow } from "../src/telegram/rich.js";

describe("containsGfmTable", () => {
	test("detects a standard pipe table", () => {
		const md = "intro text\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\noutro";
		expect(containsGfmTable(md)).toBe(true);
	});

	test("detects alignment-colon delimiters", () => {
		const md = "| Left | Center | Right |\n|:-----|:------:|------:|\n| a | b | c |";
		expect(containsGfmTable(md)).toBe(true);
	});

	test("rejects prose that merely contains pipes", () => {
		expect(containsGfmTable("a | b is not a table")).toBe(false);
	});

	test("rejects a lone --- horizontal rule", () => {
		expect(containsGfmTable("above\n\n---\n\nbelow")).toBe(false);
	});

	test("ignores tables inside fenced code blocks", () => {
		const md = "```\n| A | B |\n|---|---|\n```";
		expect(containsGfmTable(md)).toBe(false);
	});

	test("detects a table after a closed fence", () => {
		const md = "```\ncode\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |";
		expect(containsGfmTable(md)).toBe(true);
	});

	test("fast-rejects input without pipes or dashes", () => {
		expect(containsGfmTable("plain words only")).toBe(false);
	});
});

describe("splitTableRow", () => {
	test("splits cells and trims whitespace", () => {
		expect(splitTableRow("| a | b | c |")).toEqual(["a", "b", "c"]);
	});

	test("handles rows without outer pipes", () => {
		expect(splitTableRow("a | b")).toEqual(["a", "b"]);
	});
});

describe("isPermanentRichError", () => {
	test("Bad Request (content rejected) is permanent", () => {
		expect(isPermanentRichError(new Error("Bad Request: RICH_MESSAGE_INVALID"))).toBe(true);
	});

	test("method-not-found (old server) is permanent", () => {
		expect(isPermanentRichError(new Error("Not Found: method not found"))).toBe(true);
	});

	test("unauthorized/forbidden are permanent", () => {
		expect(isPermanentRichError(new Error("Unauthorized"))).toBe(true);
		expect(isPermanentRichError(new Error("Forbidden: bot was blocked"))).toBe(true);
	});

	test("network errors are NOT permanent (may have reached Telegram)", () => {
		expect(isPermanentRichError(new Error("fetch failed"))).toBe(false);
		expect(isPermanentRichError(new Error("socket hang up"))).toBe(false);
	});

	test("an empty error message is NOT permanent", () => {
		expect(isPermanentRichError(new Error(""))).toBe(false);
	});
});
