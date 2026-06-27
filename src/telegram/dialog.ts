import type { TelegramCallbackQuery, TelegramTransport } from "./transport.js";

/**
 * Dependencies for DialogManager.
 */
export interface DialogDeps {
	transport: Pick<
		TelegramTransport,
		"sendMessage" | "editMessageText" | "answerCallbackQuery"
	>;
	chatId: number;
	idGen?: () => string;
	timeoutMs?: number;
}

/**
 * A select option.
 */
export interface SelectOption {
	label: string;
	value: string;
}

/**
 * Pending select or confirm dialog.
 */
interface PendingSelectDialog {
	type: "select" | "confirm";
	messageIdPromise: Promise<number>;
	prompt: string;
	options: SelectOption[];
	resolve: (value: string | boolean) => void;
	reject: (error: Error) => void;
	timeoutHandle?: ReturnType<typeof setTimeout>;
}

/**
 * Pending text input dialog.
 */
interface PendingTextDialog {
	type: "textInput";
	resolve: (value: string) => void;
	reject: (error: Error) => void;
	timeoutHandle?: ReturnType<typeof setTimeout>;
}

/**
 * Manages native Telegram dialogs using inline keyboards.
 * Correlates callback_query events back to awaiting promises.
 */
export class DialogManager {
	private readonly transport: DialogDeps["transport"];
	private readonly chatId: number;
	private readonly idGen: () => string;
	private readonly timeoutMs?: number;

	private pendingSelects = new Map<string, PendingSelectDialog>();
	private pendingTextInput?: PendingTextDialog;
	private idCounter = 0;

	constructor(deps: DialogDeps) {
		this.transport = deps.transport;
		this.chatId = deps.chatId;
		this.idGen = deps.idGen ?? (() => `dialog_${++this.idCounter}`);
		if (deps.timeoutMs !== undefined) {
			this.timeoutMs = deps.timeoutMs;
		}
	}

	/**
	 * Show a select dialog with multiple options.
	 * Returns the value of the chosen option.
	 */
	select(prompt: string, options: SelectOption[]): Promise<string> {
		const dialogId = this.idGen();

		// Build inline keyboard
		const inline_keyboard = options.map((opt, index) => [
			{
				text: opt.label,
				callback_data: `${dialogId}:${index}`,
			},
		]);

		// Start sending message and capture the promise
		const messageIdPromise = this.transport
			.sendMessage({
				chatId: this.chatId,
				text: prompt,
				replyMarkup: { inline_keyboard },
			})
			.then((result) => result.message_id);

		// Create promise that will be resolved by handleCallbackQuery
		const promise = new Promise<string>((resolve, reject) => {
			// Set up pending dialog immediately (before async operations)
			const pending: PendingSelectDialog = {
				type: "select",
				messageIdPromise,
				prompt,
				options,
				resolve: resolve as (value: string | boolean) => void,
				reject,
			};

			// Set timeout if configured
			if (this.timeoutMs !== undefined) {
				const timeoutMs = this.timeoutMs;
				pending.timeoutHandle = setTimeout(() => {
					this.pendingSelects.delete(dialogId);
					reject(new Error("Dialog timed out"));
				}, timeoutMs);
			}

			this.pendingSelects.set(dialogId, pending);

			// Handle sendMessage errors
			messageIdPromise.catch((error) => {
				this.pendingSelects.delete(dialogId);
				if (pending.timeoutHandle !== undefined) {
					clearTimeout(pending.timeoutHandle);
				}
				reject(error);
			});
		});

		return promise;
	}

	/**
	 * Show a confirm dialog (Yes/No).
	 * Returns true for Yes, false for No.
	 */
	confirm(prompt: string): Promise<boolean> {
		const dialogId = this.idGen();

		const options: SelectOption[] = [
			{ label: "Yes", value: "true" },
			{ label: "No", value: "false" },
		];

		// Build inline keyboard
		const inline_keyboard = options.map((opt, index) => [
			{
				text: opt.label,
				callback_data: `${dialogId}:${index}`,
			},
		]);

		// Start sending message and capture the promise
		const messageIdPromise = this.transport
			.sendMessage({
				chatId: this.chatId,
				text: prompt,
				replyMarkup: { inline_keyboard },
			})
			.then((result) => result.message_id);

		// Create promise that will be resolved by handleCallbackQuery
		const promise = new Promise<boolean>((resolve, reject) => {
			// Set up pending dialog immediately (before async operations)
			const pending: PendingSelectDialog = {
				type: "confirm",
				messageIdPromise,
				prompt,
				options,
				resolve: (value) => resolve(value === "true"),
				reject,
			};

			// Set timeout if configured
			if (this.timeoutMs !== undefined) {
				const timeoutMs = this.timeoutMs;
				pending.timeoutHandle = setTimeout(() => {
					this.pendingSelects.delete(dialogId);
					reject(new Error("Dialog timed out"));
				}, timeoutMs);
			}

			this.pendingSelects.set(dialogId, pending);

			// Handle sendMessage errors
			messageIdPromise.catch((error) => {
				this.pendingSelects.delete(dialogId);
				if (pending.timeoutHandle !== undefined) {
					clearTimeout(pending.timeoutHandle);
				}
				reject(error);
			});
		});

		return promise;
	}

	/**
	 * Show a text input prompt.
	 * Returns the text provided by the user via handleText.
	 */
	textInput(prompt: string): Promise<string> {
		// Create promise that will be resolved by handleText
		const promise = new Promise<string>((resolve, reject) => {
			const pending: PendingTextDialog = {
				type: "textInput",
				resolve,
				reject,
			};

			// Set timeout if configured
			if (this.timeoutMs !== undefined) {
				const timeoutMs = this.timeoutMs;
				pending.timeoutHandle = setTimeout(() => {
					delete this.pendingTextInput;
					reject(new Error("Dialog timed out"));
				}, timeoutMs);
			}

			this.pendingTextInput = pending;

			// Send message without keyboard
			this.transport
				.sendMessage({
					chatId: this.chatId,
					text: prompt,
				})
				.catch((error) => {
					delete this.pendingTextInput;
					if (pending.timeoutHandle !== undefined) {
						clearTimeout(pending.timeoutHandle);
					}
					reject(error);
				});
		});

		return promise;
	}

	/**
	 * Handle a callback query from an inline keyboard button.
	 * Returns true if this query matched a pending dialog, false otherwise.
	 */
	async handleCallbackQuery(query: TelegramCallbackQuery): Promise<boolean> {
		if (!query.data) {
			return false;
		}

		// Parse callback_data: "dialogId:index"
		const parts = query.data.split(":");
		if (parts.length !== 2) {
			return false;
		}

		const dialogId = parts[0];
		const indexStr = parts[1];
		if (dialogId === undefined || indexStr === undefined) {
			return false;
		}

		const index = parseInt(indexStr, 10);
		if (isNaN(index)) {
			return false;
		}

		// Look up pending dialog
		const pending = this.pendingSelects.get(dialogId);
		if (!pending) {
			return false;
		}

		// Get the chosen option
		const chosen = pending.options[index];
		if (!chosen) {
			return false;
		}

		// Clear timeout if set
		if (pending.timeoutHandle !== undefined) {
			clearTimeout(pending.timeoutHandle);
		}

		// Remove from pending
		this.pendingSelects.delete(dialogId);

		// Answer the callback query
		await this.transport.answerCallbackQuery({
			callbackQueryId: query.id,
		});

		// Get the messageId and edit the message to show the chosen option
		const messageId = await pending.messageIdPromise;
		await this.transport.editMessageText({
			chatId: this.chatId,
			messageId,
			text: `${pending.prompt}\n✓ ${chosen.label}`,
			replyMarkup: { inline_keyboard: [] },
		});

		// Resolve the promise (always pass the string value, resolver will convert if needed)
		pending.resolve(chosen.value);

		return true;
	}

	/**
	 * Handle inbound text for text input dialogs.
	 * Returns true if text was consumed by a pending textInput, false otherwise.
	 */
	handleText(text: string): boolean {
		if (!this.pendingTextInput) {
			return false;
		}

		const pending = this.pendingTextInput;

		// Clear timeout if set
		if (pending.timeoutHandle !== undefined) {
			clearTimeout(pending.timeoutHandle);
		}

		// Remove from pending
		delete this.pendingTextInput;

		// Resolve the promise
		pending.resolve(text);

		return true;
	}
}
