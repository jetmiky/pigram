import { describe, expect, test } from "bun:test";
import { formatSessionStatus, formatFooterStatus, formatTokens, type SessionStatusView } from "../src/domain/status.js";

function baseView(overrides: Partial<SessionStatusView> = {}): SessionStatusView {
	return {
		provider: "9router",
		model: "kr/claude-opus-4.8",
		thinking: "medium",
		sessionName: "my-session",
		context: { tokens: 100_000, contextWindow: 200_000, percent: 50 },
		usage: { input: 14_000_000, output: 25_000 },
		busy: false,
		queued: 0,
		rootDirectory: "/home/jetmiky/projects/xvali",
		mode: "project",
		configPath: "/home/jetmiky/projects/xvali/.pi/pigram.json",
		...overrides,
	};
}

describe("formatTokens", () => {
	test("renders counts below 1000 verbatim", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(42)).toBe("42");
		expect(formatTokens(999)).toBe("999");
	});

	test("renders counts below 10k with one decimal in k", () => {
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(1234)).toBe("1.2k");
		expect(formatTokens(9999)).toBe("10.0k");
	});

	test("renders counts below 1M as rounded k", () => {
		expect(formatTokens(25000)).toBe("25k");
		expect(formatTokens(250400)).toBe("250k");
		expect(formatTokens(999999)).toBe("1000k");
	});

	test("renders counts below 10M with one decimal in M", () => {
		expect(formatTokens(1_400_000)).toBe("1.4M");
		expect(formatTokens(9_900_000)).toBe("9.9M");
	});

	test("renders counts at or above 10M as rounded M", () => {
		expect(formatTokens(14_000_000)).toBe("14M");
		expect(formatTokens(14_400_000)).toBe("14M");
	});
});

describe("formatSessionStatus", () => {
	test("renders the full status layout", () => {
		const out = formatSessionStatus(baseView());
		expect(out).toBe(
			[
				"📊 <b>Pigram Session Status</b>",
				"—",
				"🧠 <b>AI Model</b>",
				"- Provider: 9router",
				"- Model: kr/claude-opus-4.8",
				"- Thinking: medium",
				"",
				"🖥 <b>Pi State</b>",
				"- Session Name: my-session",
				"- Context: 100k / 200k (50%)",
				"- Usage: ↑14M | ↓25k",
				"- Status: Idle",
				"- Queued: 0",
				"- Root Directory: <code>/home/jetmiky/projects/xvali</code>",
				"",
				"⚙️ <b>Pigram Config</b>",
				"- Mode: Local (Project)",
				"- Loaded Config: <code>/home/jetmiky/projects/xvali/.pi/pigram.json</code>",
			].join("\n"),
		);
	});

	test("falls back to 'unnamed' when the session has no name", () => {
		const out = formatSessionStatus(baseView({ sessionName: undefined }));
		expect(out).toContain("- Session Name: unnamed");
	});

	test("labels global scope as 'Global (Machine)'", () => {
		const out = formatSessionStatus(baseView({ mode: "global" }));
		expect(out).toContain("- Mode: Global (Machine)");
	});

	test("labels project scope as 'Local (Project)'", () => {
		const out = formatSessionStatus(baseView({ mode: "project" }));
		expect(out).toContain("- Mode: Local (Project)");
	});

	test("renders the context line as tokens / window (percent%)", () => {
		const out = formatSessionStatus(
			baseView({ context: { tokens: 1_400_000, contextWindow: 200_000, percent: 73.4 } }),
		);
		expect(out).toContain("- Context: 1.4M / 200k (73%)");
	});

	test("renders context as unknown when usage is unavailable", () => {
		const out = formatSessionStatus(baseView({ context: undefined }));
		expect(out).toContain("- Context: unknown");
	});

	test("shows '?' tokens when pi reports a null token count", () => {
		const out = formatSessionStatus(
			baseView({ context: { tokens: null, contextWindow: 200_000, percent: null } }),
		);
		expect(out).toContain("- Context: ? / 200k");
	});

	test("renders cumulative usage with up/down arrows", () => {
		const out = formatSessionStatus(baseView({ usage: { input: 1_234, output: 56_789 } }));
		expect(out).toContain("- Usage: ↑1.2k | ↓57k");
	});

	test("defaults usage to zero when no assistant turns have run", () => {
		const out = formatSessionStatus(baseView({ usage: undefined }));
		expect(out).toContain("- Usage: ↑0 | ↓0");
	});

	test("reports busy state", () => {
		const out = formatSessionStatus(baseView({ busy: true }));
		expect(out).toContain("- Status: Busy");
	});

	test("HTML-escapes paths so markup in a directory cannot break the message", () => {
		const out = formatSessionStatus(
			baseView({ rootDirectory: "/tmp/<a>&b", configPath: "/tmp/<a>&b/.pi/pigram.json" }),
		);
		expect(out).toContain("- Root Directory: <code>/tmp/&lt;a&gt;&amp;b</code>");
		expect(out).toContain("- Loaded Config: <code>/tmp/&lt;a&gt;&amp;b/.pi/pigram.json</code>");
	});
});

describe("formatFooterStatus", () => {
	test("shows bot handle, mode, and config location for project scope", () => {
		expect(
			formatFooterStatus({ botUsername: "mybot", mode: "project", configPath: "/repo/.pi/pigram.json" }),
		).toBe("📱 @mybot · Local (Project) · /repo/.pi/pigram.json");
	});

	test("labels global scope", () => {
		expect(
			formatFooterStatus({
				botUsername: "mybot",
				mode: "global",
				configPath: "/home/me/.pi/agent/pigram.json",
			}),
		).toBe("📱 @mybot · Global (Machine) · /home/me/.pi/agent/pigram.json");
	});

	test("omits the handle when the bot username is unknown", () => {
		expect(
			formatFooterStatus({ mode: "project", configPath: "/repo/.pi/pigram.json" }),
		).toBe("📱 Telegram · Local (Project) · /repo/.pi/pigram.json");
	});
});
