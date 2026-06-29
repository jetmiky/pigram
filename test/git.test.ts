import { test, expect, describe } from "bun:test";
import {
	getGitExecSpec,
	formatGitReply,
	runGitSpec,
	type GitRunner,
	type GitRunResult,
} from "../src/domain/git.js";

describe("getGitExecSpec", () => {
	test("status maps to git status --short --branch", () => {
		expect(getGitExecSpec({ ok: true, kind: "status" })).toEqual({
			title: "git status",
			steps: [{ args: ["status", "--short", "--branch"] }],
		});
	});

	test("log maps to git log --oneline --decorate -20", () => {
		expect(getGitExecSpec({ ok: true, kind: "log" })).toEqual({
			title: "git log",
			steps: [{ args: ["log", "--oneline", "--decorate", "-20"] }],
		});
	});

	test("nb validates the branch name before switching", () => {
		expect(getGitExecSpec({ ok: true, kind: "nb", branchName: "feature/x" })).toEqual({
			title: "git nb feature/x",
			steps: [
				{ args: ["check-ref-format", "--branch", "feature/x"], failureTitle: "invalid branch name" },
				{ args: ["switch", "-c", "feature/x"] },
			],
		});
	});

	test("nb passes the branch name as a separate argv item (no shell interpolation)", () => {
		// A name with shell metacharacters stays a single argv element, so there
		// is nothing for a shell to interpret — execFile never sees a shell.
		const spec = getGitExecSpec({ ok: true, kind: "nb", branchName: "x; rm -rf /" });
		expect(spec.steps[1]!.args).toEqual(["switch", "-c", "x; rm -rf /"]);
	});
});

describe("formatGitReply", () => {
	test("renders title, blank line, then stdout", () => {
		expect(formatGitReply({ title: "git status", stdout: "## main\n M file", stderr: "" })).toBe(
			"git status\n\n## main\n M file",
		);
	});

	test("falls back to stderr when stdout is empty", () => {
		expect(formatGitReply({ title: "git log failed", stdout: "", stderr: "fatal: not a repo" })).toBe(
			"git log failed\n\nfatal: not a repo",
		);
	});

	test("shows (no output) when both streams are empty", () => {
		expect(formatGitReply({ title: "git nb feature/x", stdout: "", stderr: "" })).toBe(
			"git nb feature/x\n\n(no output)",
		);
	});

	test("truncates output longer than the Telegram limit", () => {
		const huge = "x".repeat(5000);
		const reply = formatGitReply({ title: "git log", stdout: huge, stderr: "" });
		expect(reply.length).toBeLessThanOrEqual(4096);
		expect(reply.endsWith("[output truncated]")).toBe(true);
	});
});

describe("runGitSpec", () => {
	// A scripted runner: records the argv it was called with and returns queued results.
	function scriptedRunner(results: GitRunResult[]): { runner: GitRunner; calls: string[][] } {
		const calls: string[][] = [];
		let i = 0;
		const runner: GitRunner = async (args) => {
			calls.push(args);
			return results[i++] ?? { exitCode: 0, stdout: "", stderr: "" };
		};
		return { runner, calls };
	}

	test("runs a single-step spec and reports its output under the title", async () => {
		const { runner, calls } = scriptedRunner([{ exitCode: 0, stdout: "## main", stderr: "" }]);
		const reply = await runGitSpec(getGitExecSpec({ ok: true, kind: "status" }), runner, "/repo");
		expect(reply).toBe("git status\n\n## main");
		expect(calls).toEqual([["status", "--short", "--branch"]]);
	});

	test("nb runs both steps in order on success", async () => {
		const { runner, calls } = scriptedRunner([
			{ exitCode: 0, stdout: "", stderr: "" }, // check-ref-format
			{ exitCode: 0, stdout: "Switched to a new branch 'feat'", stderr: "" }, // switch
		]);
		const reply = await runGitSpec(
			getGitExecSpec({ ok: true, kind: "nb", branchName: "feat" }),
			runner,
			"/repo",
		);
		expect(calls).toEqual([
			["check-ref-format", "--branch", "feat"],
			["switch", "-c", "feat"],
		]);
		expect(reply).toBe("git nb feat\n\nSwitched to a new branch 'feat'");
	});

	test("nb stops at the validation step and reports its failureTitle", async () => {
		const { runner, calls } = scriptedRunner([
			{ exitCode: 1, stdout: "", stderr: "bad ref" }, // check-ref-format fails
		]);
		const reply = await runGitSpec(
			getGitExecSpec({ ok: true, kind: "nb", branchName: "bad..name" }),
			runner,
			"/repo",
		);
		// switch must NOT run after validation fails.
		expect(calls).toEqual([["check-ref-format", "--branch", "bad..name"]]);
		expect(reply).toBe("invalid branch name\n\nbad ref");
	});

	test("a failing single-step spec uses the generic '<title> failed' title", async () => {
		const { runner } = scriptedRunner([{ exitCode: 128, stdout: "", stderr: "fatal: not a git repository" }]);
		const reply = await runGitSpec(getGitExecSpec({ ok: true, kind: "status" }), runner, "/tmp");
		expect(reply).toBe("git status failed\n\nfatal: not a git repository");
	});
});
