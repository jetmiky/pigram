/**
 * Declarative Telegram command registry and parser (pure, no I/O).
 *
 * Commands are parsed into typed intent objects. Executing intents happens
 * elsewhere (in adapters).
 */

/**
 * Specification for a single Telegram command.
 * Single source of truth for both dispatch and BotFather setup.
 */
export interface CommandSpec {
	/** Command name without leading slash */
	name: string;
	/** Description for BotFather /setcommands (verbose) */
	botFatherDescription: string;
	/** Full usage line with slash and syntax, for help reply (HTML-escaped) */
	helpUsage: string;
}

/**
 * Declarative command table.
 * This is the single source of truth for all command metadata.
 */
export const COMMAND_SPECS: CommandSpec[] = [
	{
		name: "new",
		botFatherDescription: "start a fresh pi session, optionally with a name",
		helpUsage: "/new [name] - start a fresh pi session",
	},
	{
		name: "status",
		botFatherDescription: "show session, directory, model, usage, cost, and context",
		helpUsage: "/status - show session, directory, model, usage, cost, and context",
	},
	{
		name: "model",
		botFatherDescription: "switch model, optionally including provider and thinking level",
		helpUsage: "/model [provider/]model-id [thinking-level] - switch model, optionally including provider",
	},
	{
		name: "thinking",
		botFatherDescription: "change thinking level",
		helpUsage: "/thinking &lt;level&gt; - change thinking level",
	},
	{
		name: "compact",
		botFatherDescription: "compact context",
		helpUsage: "/compact - compact context",
	},
	{
		name: "resend",
		botFatherDescription: "resend the latest assistant reply from this session",
		helpUsage: "/resend - resend the latest assistant reply from this session",
	},
	{
		name: "stop",
		botFatherDescription: "abort active turn",
		helpUsage: "/stop - abort active turn",
	},
	{
		name: "help",
		botFatherDescription: "show help",
		helpUsage: "/help - show help",
	},
	{
		name: "git",
		botFatherDescription: "run safe git shortcuts in current cwd",
		helpUsage: "/git &lt;status|log|nb&gt; - run safe git shortcuts in current cwd",
	},
];

/**
 * Git subcommand parsing result.
 */
export type GitCommand =
	| { ok: true; kind: "status" }
	| { ok: true; kind: "log" }
	| { ok: true; kind: "nb"; branchName?: string }
	| { ok: false; message: string };

/**
 * Discriminated union of all parsed command intents.
 */
export type ParsedCommand =
	| { kind: "new"; name?: string }
	| { kind: "status" }
	| { kind: "model"; model: string; thinking?: string }
	| { kind: "thinking"; level: string }
	| { kind: "compact" }
	| { kind: "resend" }
	| { kind: "stop" }
	| { kind: "help" }
	| { kind: "start" }
	| { kind: "git"; git: GitCommand }
	| { kind: "unknown" };

/**
 * Message to show for unrecognized commands.
 */
export const UNKNOWN_COMMAND_MESSAGE = "invalid command, type /help if you need help";

/**
 * Parse a git subcommand from tokens.
 * @param tokens - Array starting with "/git" followed by subcommand and args
 * @returns Parsed git command or error
 */
export function parseGitCommand(tokens: string[]): GitCommand {
	const subcommand = tokens[1];

	if (!subcommand) {
		return { ok: false, message: "usage: /git <status|log|nb>" };
	}

	switch (subcommand) {
		case "status":
			return { ok: true, kind: "status" };

		case "log":
			return { ok: true, kind: "log" };

		case "nb": {
			const branchName = tokens[2];
			if (!branchName) {
				return { ok: false, message: "usage: /git nb <branch-name>" };
			}
			if (tokens[3]) {
				return { ok: false, message: "usage: /git nb <branch-name>" };
			}
			if (branchName.startsWith("-")) {
				return { ok: false, message: "branch name cannot start with a dash" };
			}
			return { ok: true, kind: "nb", branchName };
		}

		default:
			return { ok: false, message: "usage: /git <status|log|nb>" };
	}
}

/**
 * Parse a command string into a typed intent.
 * @param text - The message text to parse
 * @returns Parsed command intent, or null if text is not a command
 */
export function parseCommand(text: string): ParsedCommand | null {
	const trimmed = text.trim();

	// Not a command if it doesn't start with /
	if (!trimmed.startsWith("/")) {
		return null;
	}

	// Split into tokens for parsing
	const tokens = trimmed.split(/\s+/);
	// Telegram appends "@botusername" to commands in group chats (e.g.
	// "/new@my_bot"). Strip it so the command matches regardless of context.
	// Args (tokens[1...]) are preserved with their original casing.
	const command = tokens[0]!.split("@", 1)[0];

	switch (command) {
		case "/new": {
			const name = tokens[1];
			return name ? { kind: "new", name } : { kind: "new" };
		}

		case "/status":
			return { kind: "status" };

		case "/model": {
			const model = tokens[1];
			if (!model) {
				return { kind: "unknown" };
			}
			const thinking = tokens[2];
			return thinking ? { kind: "model", model, thinking } : { kind: "model", model };
		}

		case "/thinking": {
			const level = tokens[1];
			if (!level) {
				return { kind: "unknown" };
			}
			return { kind: "thinking", level };
		}

		case "/compact":
			return { kind: "compact" };

		case "/resend":
			return { kind: "resend" };

		case "/stop":
			return { kind: "stop" };

		case "/help":
			return { kind: "help" };

		case "/start":
			return { kind: "start" };

		case "/git": {
			const git = parseGitCommand(tokens);
			return { kind: "git", git };
		}

		default:
			return { kind: "unknown" };
	}
}

/**
 * Format commands for BotFather /setcommands.
 * @returns Newline-joined "name - description" lines (no slashes)
 */
export function formatBotFatherCommands(): string {
	return COMMAND_SPECS.map((spec) => `${spec.name} - ${spec.botFatherDescription}`).join("\n");
}

/**
 * Format the help reply message.
 * @param opts - Options controlling the output
 * @returns Formatted help text with optional BotFather block
 */
export function formatHelpReply(opts: { includeBotFatherCommands: boolean }): string {
	let result = "Send me a message and I will forward it to pi.\n\nCommands:\n";
	result += COMMAND_SPECS.map((spec) => spec.helpUsage).join("\n");

	if (opts.includeBotFatherCommands) {
		result += "\n\nCopy this into BotFather /setcommands:\n\n";
		result += "<pre>" + formatBotFatherCommands() + "</pre>";
	}

	return result;
}
