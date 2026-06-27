/**
 * Optional capability for sending ephemeral draft messages.
 * When it throws, we permanently fall back to message mode.
 */
export type DraftSender = (opts: { chatId: number; draftId: number; text: string }) => Promise<void>;

/**
 * Dependencies for PreviewStreamer.
 */
export interface PreviewStreamerDeps {
	transport: {
		sendMessage(opts: { chatId: number; text: string }): Promise<{ message_id: number }>;
		editMessageText(opts: { chatId: number; messageId: number; text: string }): Promise<void>;
	};
	sendDraft?: DraftSender;
	enabled: boolean;
	now?: () => number;
}

/**
 * Manages streaming preview updates for a single chat.
 * Tries draft mode first (if provided); falls back to message mode on failure.
 */
export class PreviewStreamer {
	private readonly chatId: number;
	private readonly deps: PreviewStreamerDeps;
	private lastSentText: string | undefined;
	private messageId: number | undefined;
	private draftId: number | undefined;
	private mode: "draft" | "message" | "unknown" = "unknown";
	private draftKnownUnsupported = false;

	constructor(chatId: number, deps: PreviewStreamerDeps) {
		this.chatId = chatId;
		this.deps = deps;
	}

	/**
	 * Update the preview with new partial text.
	 * No-op when previews are disabled.
	 * Deduplicates identical consecutive text.
	 * Trims and skips empty text.
	 */
	async update(text: string): Promise<void> {
		if (!this.deps.enabled) return;

		const trimmed = text.trim();
		if (!trimmed) return;
		if (trimmed === this.lastSentText) return;

		// Try draft mode if available and not known to be unsupported
		if (this.deps.sendDraft && !this.draftKnownUnsupported && this.mode !== "message") {
			if (this.draftId === undefined) {
				this.draftId = this.allocateDraftId();
			}

			try {
				await this.deps.sendDraft({ chatId: this.chatId, draftId: this.draftId, text: trimmed });
				this.mode = "draft";
				this.lastSentText = trimmed;
				return;
			} catch {
				// Draft failed, mark as unsupported and fall back to message mode
				this.draftKnownUnsupported = true;
				this.mode = "message";
				// Fall through to message mode below
			}
		}

		// Message mode: sendMessage on first call, editMessageText thereafter
		if (this.messageId === undefined) {
			const result = await this.deps.transport.sendMessage({ chatId: this.chatId, text: trimmed });
			this.messageId = result.message_id;
			this.mode = "message";
			this.lastSentText = trimmed;
		} else {
			await this.deps.transport.editMessageText({
				chatId: this.chatId,
				messageId: this.messageId,
				text: trimmed,
			});
			this.lastSentText = trimmed;
		}
	}

	/**
	 * Finalize the preview with the final reply text.
	 * When disabled, returns {sent: false}.
	 * In draft mode: sends a real message (drafts are ephemeral).
	 * In message mode: edits the existing message or sends new if none.
	 * Returns {sent: false} for empty text.
	 */
	async finalize(finalText: string): Promise<{ messageId?: number; sent: boolean }> {
		if (!this.deps.enabled) {
			return { sent: false };
		}

		const trimmed = finalText.trim();
		if (!trimmed) {
			return { sent: false };
		}

		// Draft mode: send a real message (drafts are ephemeral)
		if (this.mode === "draft") {
			const result = await this.deps.transport.sendMessage({ chatId: this.chatId, text: trimmed });
			return { messageId: result.message_id, sent: true };
		}

		// Message mode: edit existing or send new
		if (this.messageId !== undefined) {
			await this.deps.transport.editMessageText({
				chatId: this.chatId,
				messageId: this.messageId,
				text: trimmed,
			});
			return { sent: true };
		}

		// No message sent yet, send new
		const result = await this.deps.transport.sendMessage({ chatId: this.chatId, text: trimmed });
		return { messageId: result.message_id, sent: true };
	}

	/**
	 * Clear pending state.
	 * Resets deduplication and mode, but keeps the permanent draftKnownUnsupported flag.
	 */
	async clear(): Promise<void> {
		this.lastSentText = undefined;
		this.messageId = undefined;
		this.draftId = undefined;
		this.mode = "unknown";
		// Note: draftKnownUnsupported is NOT reset - it's a permanent flag
	}

	/**
	 * Allocate a stable draft ID based on current timestamp.
	 */
	private allocateDraftId(): number {
		const now = this.deps.now ? this.deps.now() : Date.now();
		return Math.floor(now / 1000);
	}
}
