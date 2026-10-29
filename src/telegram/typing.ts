/**
 * Repeating "typing…" indicator for a Telegram chat.
 *
 * Sends `sendChatAction("typing")` immediately on start and then every
 * `intervalMs` milliseconds until `stop()` is called. The Telegram typing
 * indicator expires after ~5 s, so the default interval of 4 s keeps it alive
 * continuously.
 *
 * Timer primitives are injected so tests can drive ticks deterministically.
 */
import type { TelegramTransport } from "./transport.js";

export interface TypingDeps {
	sendChatAction: TelegramTransport["sendChatAction"];
	setInterval: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>;
	clearInterval: (id: ReturnType<typeof globalThis.setInterval>) => void;
}

const DEFAULT_INTERVAL_MS = 4_000;

export class TypingIndicator {
	private readonly chatId: number;
	private readonly deps: TypingDeps;
	private readonly intervalMs: number;
	private timerId: ReturnType<typeof globalThis.setInterval> | undefined;
	private running = false;

	constructor(chatId: number, deps: TypingDeps, intervalMs = DEFAULT_INTERVAL_MS) {
		this.chatId = chatId;
		this.deps = deps;
		this.intervalMs = intervalMs;
	}

	/** Send typing immediately and begin the repeat interval. */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.fire();
		this.timerId = this.deps.setInterval(() => this.fire(), this.intervalMs);
	}

	/** Stop repeating. Idempotent — safe to call multiple times. */
	stop(): void {
		if (!this.running) return;
		this.running = false;

		if (this.timerId !== undefined) {
			this.deps.clearInterval(this.timerId);
			this.timerId = undefined;
		}
	}

	private fire(): void {
		void this.deps.sendChatAction({ chatId: this.chatId, action: "typing" }).catch(() => undefined);
	}
}
