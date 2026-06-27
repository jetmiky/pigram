import type { TelegramTransport, TelegramUpdate } from "./transport.js";

/**
 * Handler for a single Telegram update.
 */
export type UpdateHandler = (update: TelegramUpdate) => Promise<void>;

/**
 * Dependencies for TelegramPoller.
 */
export interface PollerDeps {
	/**
	 * Transport to fetch updates from.
	 */
	transport: Pick<TelegramTransport, "getUpdates">;

	/**
	 * Handler to process each update.
	 */
	handler: UpdateHandler;

	/**
	 * Get the current update cursor (last processed update_id).
	 */
	getCursor: () => number;

	/**
	 * Persist the new update cursor after processing an update.
	 */
	setCursor: (updateId: number) => Promise<void>;

	/**
	 * Timeout in seconds for long polling (passed to getUpdates).
	 * Defaults to 30.
	 */
	pollTimeoutSeconds?: number;

	/**
	 * Optional error handler for non-abort errors.
	 * The loop continues after calling this.
	 */
	onError?: (err: unknown) => void;

	/**
	 * Delay in milliseconds after a non-abort error before retrying.
	 * Defaults to 0 (useful for fast tests).
	 */
	errorDelayMs?: number;

	/**
	 * Delay in milliseconds after a Telegram 409 "Conflict: terminated by other
	 * getUpdates request" error. This conflict means another poller is (or was)
	 * consuming updates for the same bot — typically a previous session's poll
	 * that has not yet wound down (e.g. right after /new). A longer backoff than
	 * a normal error gives the competing consumer time to terminate Telegram-side
	 * instead of two pollers ping-ponging 409s at each other. Defaults to 3000.
	 */
	conflictDelayMs?: number;
}

/**
 * Long-polling update fetcher for Telegram.
 * Pulls updates from the transport and routes them to a handler.
 */
export class TelegramPoller {
	private readonly transport: Pick<TelegramTransport, "getUpdates">;
	private readonly handler: UpdateHandler;
	private readonly getCursor: () => number;
	private readonly setCursor: (updateId: number) => Promise<void>;
	private readonly pollTimeoutSeconds: number;
	private readonly onError: ((err: unknown) => void) | undefined;
	private readonly errorDelayMs: number;
	private readonly conflictDelayMs: number;

	constructor(deps: PollerDeps) {
		this.transport = deps.transport;
		this.handler = deps.handler;
		this.getCursor = deps.getCursor;
		this.setCursor = deps.setCursor;
		this.pollTimeoutSeconds = deps.pollTimeoutSeconds ?? 30;
		this.onError = deps.onError;
		this.errorDelayMs = deps.errorDelayMs ?? 0;
		this.conflictDelayMs = deps.conflictDelayMs ?? 3000;
	}

	/**
	 * Start the long-polling loop.
	 * Runs until the signal is aborted.
	 */
	async start(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				const offset = this.getCursor() + 1;
				const updates = await this.transport.getUpdates(
					{
						offset,
						timeout: this.pollTimeoutSeconds,
					},
					signal,
				);

				// Process each update in order
				for (const update of updates) {
					// Check if aborted before processing
					if (signal.aborted) {
						return;
					}

					// Persist the cursor BEFORE dispatching the handler, not
					// after. A handler may tear down this very poller mid-flight
					// — most notably /new, which calls newSession() and rebuilds
					// the extension runtime while we are still awaiting the
					// handler. If we advanced the cursor only afterwards, that
					// teardown would skip the persist, the replacement session
					// would restore the stale cursor, and Telegram would
					// re-deliver the same update (a phantom second /new). Saving
					// first gives at-most-once delivery, which is the correct
					// trade-off for commands that must never double-fire.
					await this.setCursor(update.update_id);
					await this.handler(update);
				}
			} catch (err) {
				// If the error is due to abort, exit cleanly
				if (this.isAbortError(err)) {
					return;
				}

				// For other errors, call the error handler and continue
				if (this.onError) {
					this.onError(err);
				}

				// A 409 conflict means another poller holds this bot's getUpdates
				// (e.g. a previous session winding down after /new). Back off
				// longer so it can terminate, instead of racing it. Other errors
				// use the normal short delay.
				const delay = this.isConflictError(err) ? this.conflictDelayMs : this.errorDelayMs;
				if (delay > 0) {
					await this.sleep(delay);
				}
			}
		}
	}

	/**
	 * Check if an error is an AbortError.
	 */
	private isAbortError(err: unknown): boolean {
		return (
			err instanceof Error &&
			(err.name === "AbortError" || err.message.includes("aborted"))
		);
	}

	/**
	 * Check if an error is Telegram's 409 getUpdates conflict.
	 * Telegram phrases it "Conflict: terminated by other getUpdates request";
	 * we match the stable "Conflict" + "getUpdates" signal case-insensitively.
	 */
	private isConflictError(err: unknown): boolean {
		if (!(err instanceof Error)) return false;
		const msg = err.message.toLowerCase();
		return msg.includes("conflict") && msg.includes("getupdates");
	}

	/**
	 * Sleep for the specified number of milliseconds.
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
