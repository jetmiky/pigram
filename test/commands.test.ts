import { describe, expect, test } from "bun:test";
import {
	UNKNOWN_COMMAND_MESSAGE,
	formatBotFatherCommands,
	formatHelpReply,
	parseCommand,
	parseGitCommand,
	type ParsedCommand,
} from "../src/domain/commands.js";

describe("parseCommand", () => {
	test("returns null for non-command text", () => {
		expect(parseCommand("hello")).toBeNull();
		expect(parseCommand("just a message")).toBeNull();
		expect(parseCommand("")).toBeNull();
	});

	test("parses /new without name", () => {
		expect(parseCommand("/new")).toEqual({ kind: "new" });
	});

	test("parses /new with name", () => {
		expect(parseCommand("/new myname")).toEqual({ kind: "new", name: "myname" });
		expect(parseCommand("/new my-session")).toEqual({ kind: "new", name: "my-session" });
	});

	test("parses /status", () => {
		expect(parseCommand("/status")).toEqual({ kind: "status" });
	});

	test("parses /compact", () => {
		expect(parseCommand("/compact")).toEqual({ kind: "compact" });
	});

	test("parses /resend", () => {
		expect(parseCommand("/resend")).toEqual({ kind: "resend" });
	});

	test("parses /stop", () => {
		expect(parseCommand("/stop")).toEqual({ kind: "stop" });
	});

	test("parses /help", () => {
		expect(parseCommand("/help")).toEqual({ kind: "help" });
	});

	test("parses /start", () => {
		expect(parseCommand("/start")).toEqual({ kind: "start" });
	});

	test("parses /model with model only", () => {
		expect(parseCommand("/model gpt-5")).toEqual({ kind: "model", model: "gpt-5" });
	});

	test("parses /model with provider/model", () => {
		expect(parseCommand("/model openai/gpt-5")).toEqual({ kind: "model", model: "openai/gpt-5" });
	});

	test("parses /model with model and thinking level", () => {
		expect(parseCommand("/model gpt-5 high")).toEqual({ kind: "model", model: "gpt-5", thinking: "high" });
	});

	test("parses /model with provider/model and thinking level", () => {
		expect(parseCommand("/model openai/gpt-5 medium")).toEqual({
			kind: "model",
			model: "openai/gpt-5",
			thinking: "medium",
		});
	});

	test("parses /thinking with level", () => {
		expect(parseCommand("/thinking high")).toEqual({ kind: "thinking", level: "high" });
		expect(parseCommand("/thinking low")).toEqual({ kind: "thinking", level: "low" });
	});

	test("parses /git commands", () => {
		expect(parseCommand("/git status")).toEqual({
			kind: "git",
			git: { ok: true, kind: "status" },
		});
		expect(parseCommand("/git log")).toEqual({
			kind: "git",
			git: { ok: true, kind: "log" },
		});
		expect(parseCommand("/git nb feature/foo")).toEqual({
			kind: "git",
			git: { ok: true, kind: "nb", branchName: "feature/foo" },
		});
	});

	test("returns unknown for unrecognized slash command", () => {
		expect(parseCommand("/bogus")).toEqual({ kind: "unknown" });
		expect(parseCommand("/invalid")).toEqual({ kind: "unknown" });
	});
});

describe("parseGitCommand", () => {
	test("parses status", () => {
		expect(parseGitCommand(["/git", "status"])).toEqual({ ok: true, kind: "status" });
	});

	test("parses log", () => {
		expect(parseGitCommand(["/git", "log"])).toEqual({ ok: true, kind: "log" });
	});

	test("parses nb with branch name", () => {
		expect(parseGitCommand(["/git", "nb", "feature/foo"])).toEqual({
			ok: true,
			kind: "nb",
			branchName: "feature/foo",
		});
		expect(parseGitCommand(["/git", "nb", "main"])).toEqual({
			ok: true,
			kind: "nb",
			branchName: "main",
		});
	});

	test("returns usage error for nb without branch name", () => {
		expect(parseGitCommand(["/git", "nb"])).toEqual({
			ok: false,
			message: "usage: /git nb <branch-name>",
		});
	});

	test("returns error for nb with branch starting with dash", () => {
		expect(parseGitCommand(["/git", "nb", "-bad"])).toEqual({
			ok: false,
			message: "branch name cannot start with a dash",
		});
	});

	test("returns usage error for nb with extra args", () => {
		expect(parseGitCommand(["/git", "nb", "foo", "bar"])).toEqual({
			ok: false,
			message: "usage: /git nb <branch-name>",
		});
	});

	test("returns usage error for no subcommand", () => {
		expect(parseGitCommand(["/git"])).toEqual({
			ok: false,
			message: "usage: /git <status|log|nb>",
		});
	});

	test("returns usage error for unknown subcommand", () => {
		expect(parseGitCommand(["/git", "diff"])).toEqual({
			ok: false,
			message: "usage: /git <status|log|nb>",
		});
		expect(parseGitCommand(["/git", "push"])).toEqual({
			ok: false,
			message: "usage: /git <status|log|nb>",
		});
	});
});

describe("formatBotFatherCommands", () => {
	test("formats commands without slashes", () => {
		const result = formatBotFatherCommands();
		expect(result).toContain("new - start a fresh pi session, optionally with a name");
		expect(result).toContain("git - run safe git shortcuts in current cwd");
		expect(result).not.toContain("/new");
		expect(result).not.toContain("/git");
	});

	test("matches expected format exactly", () => {
		expect(formatBotFatherCommands()).toBe(
			`new - start a fresh pi session, optionally with a name
status - show session, directory, model, usage, cost, and context
model - switch model, optionally including provider and thinking level
thinking - change thinking level
compact - compact context
resend - resend the latest assistant reply from this session
stop - abort active turn
help - show help
git - run safe git shortcuts in current cwd`,
		);
	});
});

describe("formatHelpReply", () => {
	test("includes intro and commands", () => {
		const result = formatHelpReply({ includeBotFatherCommands: false });
		expect(result).toContain("Send me a message and I will forward it to pi.");
		expect(result).toContain("Commands:");
		expect(result).toContain("/new [name]");
		expect(result).toContain("/git &lt;status|log|nb&gt;");
	});

	test("does not include BotFather block when not requested", () => {
		const result = formatHelpReply({ includeBotFatherCommands: false });
		expect(result).not.toContain("<pre>");
		expect(result).not.toContain("Copy this into BotFather");
	});

	test("includes BotFather block when requested", () => {
		const result = formatHelpReply({ includeBotFatherCommands: true });
		expect(result).toContain("Copy this into BotFather /setcommands:");
		expect(result).toContain("<pre>");
		expect(result).toContain("</pre>");
	});

	test("matches expected format exactly with BotFather commands", () => {
		expect(formatHelpReply({ includeBotFatherCommands: true })).toBe(
			`Send me a message and I will forward it to pi.

Commands:
/new [name] - start a fresh pi session
/status - show session, directory, model, usage, cost, and context
/model [provider/]model-id [thinking-level] - switch model, optionally including provider
/thinking &lt;level&gt; - change thinking level
/compact - compact context
/resend - resend the latest assistant reply from this session
/stop - abort active turn
/help - show help
/git &lt;status|log|nb&gt; - run safe git shortcuts in current cwd

Copy this into BotFather /setcommands:

<pre>new - start a fresh pi session, optionally with a name
status - show session, directory, model, usage, cost, and context
model - switch model, optionally including provider and thinking level
thinking - change thinking level
compact - compact context
resend - resend the latest assistant reply from this session
stop - abort active turn
help - show help
git - run safe git shortcuts in current cwd</pre>`,
		);
	});

	test("matches expected format exactly without BotFather commands", () => {
		expect(formatHelpReply({ includeBotFatherCommands: false })).toBe(
			`Send me a message and I will forward it to pi.

Commands:
/new [name] - start a fresh pi session
/status - show session, directory, model, usage, cost, and context
/model [provider/]model-id [thinking-level] - switch model, optionally including provider
/thinking &lt;level&gt; - change thinking level
/compact - compact context
/resend - resend the latest assistant reply from this session
/stop - abort active turn
/help - show help
/git &lt;status|log|nb&gt; - run safe git shortcuts in current cwd`,
		);
	});
});

describe("UNKNOWN_COMMAND_MESSAGE", () => {
	test("has expected text", () => {
		expect(UNKNOWN_COMMAND_MESSAGE).toBe("invalid command, type /help if you need help");
	});
});
