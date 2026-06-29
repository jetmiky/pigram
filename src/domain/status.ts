/**
 * Pure formatters for the Telegram /status reply (no I/O).
 *
 * The composition root aggregates live data from pi (model, context usage,
 * cumulative token usage) and the pigram config layer (scope, config path,
 * queued count), then hands a plain view object to formatSessionStatus. Keeping
 * this module pure mirrors formatHelpReply and keeps the status layout unit-
 * testable without touching pi or Telegram.
 */

/**
 * Format a token count into a compact human-readable string (e.g. 14M, 25k).
 * Mirrors the upstream pi-telegram heuristic so numbers line up with pi's own
 * footer.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Context usage for the active model, as reported by pi's getContextUsage(). */
export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/** Cumulative token usage across the session (summed assistant entries). */
export interface TokenUsage {
	input: number;
	output: number;
}

/**
 * Plain, fully-resolved view of the data shown by /status. The composition root
 * builds this from pi (provider, model, thinking, sessionName, context, usage,
 * busy, rootDirectory) and the config layer (queued, mode, configPath); this
 * module only lays it out.
 */
export interface SessionStatusView {
	provider?: string;
	model?: string;
	thinking: string;
	sessionName?: string;
	context?: ContextUsage;
	usage?: TokenUsage;
	busy: boolean;
	queued: number;
	rootDirectory?: string;
	mode: "project" | "global";
	configPath: string;
}

/** Escape text destined for a Telegram HTML message. */
function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Wrap text in inline monospace, escaping its contents first. */
function code(text: string): string {
	return `<code>${escapeHtml(text)}</code>`;
}

/** Human label for a config scope. */
function formatMode(mode: SessionStatusView["mode"]): string {
	return mode === "global" ? "Global (Machine)" : "Local (Project)";
}

/** Build the "Context: tokens / window (percent%)" line, or a fallback. */
function formatContextLine(context: ContextUsage | undefined): string {
	if (!context) return "- Context: unknown";
	const tokens = context.tokens !== null ? formatTokens(context.tokens) : "?";
	const window = formatTokens(context.contextWindow);
	const percent = context.percent !== null ? ` (${Math.round(context.percent)}%)` : "";
	return `- Context: ${tokens} / ${window}${percent}`;
}

/**
 * Render the /status reply as Telegram HTML.
 */
export function formatSessionStatus(view: SessionStatusView): string {
	const lines: string[] = [
		"📊 <b>Pigram Session Status</b>",
		"—",
		"🧠 <b>AI Model</b>",
		`- Provider: ${escapeHtml(view.provider ?? "unknown")}`,
		`- Model: ${escapeHtml(view.model ?? "unknown")}`,
		`- Thinking: ${escapeHtml(view.thinking)}`,
		"",
		"🖥 <b>Pi State</b>",
		`- Session Name: ${escapeHtml(view.sessionName ?? "unnamed")}`,
		formatContextLine(view.context),
		`- Usage: ↑${formatTokens(view.usage?.input ?? 0)} | ↓${formatTokens(view.usage?.output ?? 0)}`,
		`- Status: ${view.busy ? "Busy" : "Idle"}`,
		`- Queued: ${view.queued}`,
		`- Root Directory: ${view.rootDirectory ? code(view.rootDirectory) : "unknown"}`,
		"",
		"⚙️ <b>Pigram Config</b>",
		`- Mode: ${formatMode(view.mode)}`,
		`- Loaded Config: ${code(view.configPath)}`,
	];
	return lines.join("\n");
}

/** Data shown in the pi footer/status bar while the bridge is connected. */
export interface FooterStatusView {
	botUsername?: string;
	mode: "project" | "global";
	configPath: string;
}

/**
 * Format the one-line pi footer status set via ctx.ui.setStatus. Plain text
 * (the footer is not HTML): bot handle, active scope, and config location, so
 * the user can see at a glance that Telegram is connected and which config is
 * loaded.
 */
export function formatFooterStatus(view: FooterStatusView): string {
	const handle = view.botUsername ? `@${view.botUsername}` : "Telegram";
	return `📱 ${handle} · ${formatMode(view.mode)} · ${view.configPath}`;
}
