/**
 * Pure logic for the /git command: map a parsed git subcommand into a sequence
 * of git argv steps, run them through an injected runner, and format the reply.
 *
 * No I/O lives here. The actual `execFile("git", ...)` runner is supplied by the
 * composition root, which keeps this module fully unit-testable with a fake
 * runner and free of any node:child_process import.
 *
 * Adapted from the design in jetmiky/pi-telegram (getTelegramGitExecSpec /
 * runGit / formatTelegramGitReply): an exec-spec carries an ordered list of
 * steps so `nb` can validate the branch name with `git check-ref-format`
 * BEFORE creating it, stopping at the first failing step.
 */

import type { GitCommand } from "./commands.js";

/** A safe git invocation: argv only, never a shell string (injection-proof). */
export interface GitExecStep {
	/** Arguments passed to `git` (e.g. ["status", "--short", "--branch"]). */
	args: string[];
	/** Title used when THIS step fails; falls back to "<spec.title> failed". */
	failureTitle?: string;
}

/** An ordered plan of git steps to run for one /git subcommand. */
export interface GitExecSpec {
	/** Human-readable title shown above the command output. */
	title: string;
	/** Steps run in order; execution stops at the first non-zero exit. */
	steps: GitExecStep[];
}

/** The result of running a single git step. */
export interface GitRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Runs `git <args>` in `cwd`. Injected so the orchestration stays pure. */
export type GitRunner = (args: string[], cwd: string) => Promise<GitRunResult>;

/** Telegram's hard per-message character cap; long output is truncated. */
const MAX_MESSAGE_LENGTH = 4096;
const TRUNCATION_NOTE = "\n\n[output truncated]";

/**
 * Map a successfully-parsed git subcommand to its exec-spec.
 *
 *  - status → git status --short --branch
 *  - log    → git log --oneline --decorate -20
 *  - nb      → git check-ref-format --branch <name> (validate), then git switch -c <name>
 */
export function getGitExecSpec(command: Extract<GitCommand, { ok: true }>): GitExecSpec {
	if (command.kind === "status") {
		return { title: "git status", steps: [{ args: ["status", "--short", "--branch"] }] };
	}
	if (command.kind === "log") {
		return { title: "git log", steps: [{ args: ["log", "--oneline", "--decorate", "-20"] }] };
	}
	// nb: parseGitCommand guarantees a branchName when ok, but guard anyway.
	const branchName = command.branchName ?? "";
	return {
		title: `git nb ${branchName}`,
		steps: [
			{ args: ["check-ref-format", "--branch", branchName], failureTitle: "invalid branch name" },
			{ args: ["switch", "-c", branchName] },
		],
	};
}

/**
 * Format a git step result into a Telegram reply: a title line, a blank line,
 * then stdout (or stderr, or "(no output)"). Truncated to Telegram's limit.
 */
export function formatGitReply(input: { title: string; stdout: string; stderr: string }): string {
	const output = input.stdout || input.stderr;
	const body = output.length > 0 ? output : "(no output)";
	const reply = `${input.title}\n\n${body}`;
	if (reply.length > MAX_MESSAGE_LENGTH) {
		return reply.slice(0, MAX_MESSAGE_LENGTH - TRUNCATION_NOTE.length) + TRUNCATION_NOTE;
	}
	return reply;
}

/**
 * Run an exec-spec through the injected runner and produce the reply text.
 * Steps run in order; the first non-zero exit stops the run and reports that
 * step's failure (using its failureTitle when set). On success the last step's
 * output is reported under the spec title.
 */
export async function runGitSpec(spec: GitExecSpec, runner: GitRunner, cwd: string): Promise<string> {
	let result: GitRunResult | undefined;
	for (const step of spec.steps) {
		result = await runner(step.args, cwd);
		if (result.exitCode !== 0) {
			const title = step.failureTitle ?? `${spec.title} failed`;
			return formatGitReply({ title, stdout: result.stdout, stderr: result.stderr });
		}
	}
	// spec.steps is never empty, so result is always defined here.
	return formatGitReply({ title: spec.title, stdout: result!.stdout, stderr: result!.stderr });
}
