/**
 * Notify domain module.
 *
 * `/pigram-notify` (a pi-session command) arms a pending notify request so the
 * NEXT agent turn's reply is delivered to Telegram even when the prompt was
 * typed in the laptop terminal (no active Telegram turn exists). This closes
 * the "prompt at the desk, answer on the phone" workflow.
 *
 * Two modes:
 *  - "once"   — arm for the next completed turn only, then disarm (default).
 *  - "sticky" — keep delivering every turn's reply until turned off.
 *
 * Pure functions only: parsing the command argument and deciding what an
 * agent_end event should deliver. The composition root owns the armed state
 * and performs the actual sending, mirroring how pairing/commands are split.
 */

/** How long an armed notify request stays active. */
export type NotifyMode = "once" | "sticky";

/** A pending notify request: where to deliver and until when. */
export interface PendingNotify {
	mode: NotifyMode;
	/** Target Telegram chat (usually the paired user's DM chat). */
	chatId: number;
}

/** A session command can explicitly suppress config-driven delivery. */
export type NotifyOverride = PendingNotify | "off";

/** Resolve the effective request for a terminal-originated turn. */
export function resolveNotifyRequest(
	override: NotifyOverride | undefined,
	configured: "off" | "all",
	pairedChatId: number | undefined,
): PendingNotify | undefined {
	if (override === "off") return undefined;
	if (override) return override;
	if (configured === "all" && pairedChatId !== undefined) {
		return { mode: "sticky", chatId: pairedChatId };
	}
	return undefined;
}

/** The parsed result of the /pigram-notify command arguments. */
export type ParsedNotifyArgs =
	| { ok: true; mode: NotifyMode | "off" }
	| { ok: false; message: string };

export const NOTIFY_USAGE_MESSAGE = "usage: /pigram-notify [on|off] — no arg arms one delivery of the next reply";

/**
 * Parse the raw command argument string into a notify intent.
 * Pure: no I/O, no state.
 */
export function parseNotifyArgs(raw: string): ParsedNotifyArgs {
	const arg = raw.trim().toLowerCase();
	if (arg === "") return { ok: true, mode: "once" };
	if (arg === "on") return { ok: true, mode: "sticky" };
	if (arg === "off") return { ok: true, mode: "off" };
	return { ok: false, message: NOTIFY_USAGE_MESSAGE };
}

/** What an agent_end event should do about notifications. */
export type NotifyDelivery =
	| { kind: "text"; chatId: number; markdown: string }
	| { kind: "error"; chatId: number; line: string };

/**
 * Outcome of consuming an armed request against a completed agent turn.
 * `deliver` is undefined when nothing should be sent this time;
 * `pending` is the (possibly unchanged) armed state after the turn.
 */
export interface NotifyConsumeResult {
	deliver?: NotifyDelivery;
	pending?: PendingNotify;
}

/**
 * Decide whether an agent_end event produces a notification and what happens
 * to the armed request afterwards.
 *
 * Rules:
 *  - No armed request → nothing.
 *  - Turn produced text → deliver it ("once" disarms, "sticky" stays armed).
 *  - Turn failed with an error → deliver the error line, same arming rule as
 *    text (the user asked to be notified about THIS turn's outcome).
 *  - Turn aborted or produced neither text nor error → treat as "no outcome
 *    yet": keep the request armed so a later successful turn still notifies.
 */
export function consumePendingNotify(
	pending: PendingNotify | undefined,
	outcome: { text?: string; errorMessage?: string },
): NotifyConsumeResult {
	if (!pending) return {};

	let deliver: NotifyDelivery | undefined;
	if (outcome.text) {
		deliver = { kind: "text", chatId: pending.chatId, markdown: outcome.text };
	} else if (outcome.errorMessage) {
		deliver = { kind: "error", chatId: pending.chatId, line: `⚠️ ${outcome.errorMessage}` };
	}

	if (!deliver) {
		// Aborted turn / empty reply: stay armed for the next completed turn.
		return { pending };
	}
	return pending.mode === "once" ? { deliver } : { deliver, pending };
}
