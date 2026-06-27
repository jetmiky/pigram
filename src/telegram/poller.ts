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

	constructor(deps: PollerDeps) {
		this.transport = deps.transport;
		this.handler = deps.handler;
		this.getCursor = deps.getCursor;
		this.setCursor = deps.setCursor;
		this.pollTimeoutSeconds = deps.pollTimeoutSeconds ?? 30;
		this.onError = deps.onError;
		this.errorDelayMs = deps.errorDelayMs ?? 0;
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

					await this.handler(update);
					await this.setCursor(update.update_id);
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

				// Optional delay before retrying (0 in tests for speed)
				if (this.errorDelayMs > 0) {
					await this.sleep(this.errorDelayMs);
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
	 * Sleep for the specified number of milliseconds.
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
