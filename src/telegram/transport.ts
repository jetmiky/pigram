import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Minimal Telegram user shape.
 */
export interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	last_name?: string;
	username?: string;
}

/**
 * Minimal Telegram chat shape.
 */
export interface TelegramChat {
	id: number;
	type: "private" | "group" | "supergroup" | "channel";
	title?: string;
	username?: string;
	first_name?: string;
	last_name?: string;
}

/**
 * Telegram photo size.
 */
export interface TelegramPhotoSize {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	file_size?: number;
}

/**
 * Telegram document.
 */
export interface TelegramDocument {
	file_id: string;
	file_unique_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

/**
 * Telegram voice message.
 */
export interface TelegramVoice {
	file_id: string;
	file_unique_id: string;
	duration: number;
	mime_type?: string;
	file_size?: number;
}

/**
 * Telegram message.
 */
export interface TelegramMessage {
	message_id: number;
	from?: TelegramUser;
	date: number;
	chat: TelegramChat;
	text?: string;
	caption?: string;
	photo?: TelegramPhotoSize[];
	document?: TelegramDocument;
	voice?: TelegramVoice;
}

/**
 * Telegram callback query (from inline keyboard button).
 */
export interface TelegramCallbackQuery {
	id: string;
	from: TelegramUser;
	message?: TelegramMessage;
	data?: string;
}

/**
 * Telegram update.
 */
export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

/**
 * Telegram Bot API response envelope.
 */
interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
}

/**
 * Result of getFile API call.
 */
interface TelegramGetFileResult {
	file_id: string;
	file_unique_id: string;
	file_size?: number;
	file_path?: string;
}

/**
 * The seam to the Telegram Bot API.
 * Knows how to fetch updates, send and edit messages, upload files, and download inbound files.
 */
export interface TelegramTransport {
	/**
	 * Get bot identity.
	 */
	getMe(): Promise<{ id: number; username?: string; is_bot: boolean; first_name: string }>;

	/**
	 * Fetch updates with long polling.
	 */
	getUpdates(
		opts: { offset?: number; timeout?: number },
		signal?: AbortSignal,
	): Promise<TelegramUpdate[]>;

	/**
	 * Send a text message.
	 */
	sendMessage(opts: {
		chatId: number;
		text: string;
		parseMode?: "HTML";
		replyMarkup?: unknown;
	}): Promise<{ message_id: number }>;

	/**
	 * Edit an existing message.
	 */
	editMessageText(opts: {
		chatId: number;
		messageId: number;
		text: string;
		parseMode?: "HTML";
		replyMarkup?: unknown;
	}): Promise<void>;

	/**
	 * Send a Bot API 10.1 rich message from raw markdown.
	 * Telegram renders GFM pipe tables as native bordered tables.
	 * Throws on any API error; callers classify via isPermanentRichError.
	 */
	sendRichMessage(opts: { chatId: number; markdown: string }): Promise<{ message_id: number }>;

	/**
	 * Edit an existing message into a Bot API 10.1 rich message.
	 */
	editMessageRich(opts: { chatId: number; messageId: number; markdown: string }): Promise<void>;

	/**
	 * Send a chat action (typing indicator, upload indicator, etc).
	 */
	sendChatAction(opts: {
		chatId: number;
		action: "typing" | "upload_document" | "upload_photo";
	}): Promise<void>;

	/**
	 * Answer a callback query from an inline keyboard button.
	 */
	answerCallbackQuery(opts: { callbackQueryId: string; text?: string }): Promise<void>;

	/**
	 * Upload and send a document.
	 */
	sendDocument(opts: {
		chatId: number;
		filePath: string;
		fileName: string;
		caption?: string;
	}): Promise<{ message_id: number }>;

	/**
	 * Upload and send a photo.
	 */
	sendPhoto(opts: {
		chatId: number;
		filePath: string;
		fileName: string;
		caption?: string;
	}): Promise<{ message_id: number }>;

	/**
	 * Download a file from Telegram.
	 * Returns the destination path.
	 */
	downloadFile(opts: { fileId: string; destPath: string }): Promise<string>;
}

/**
 * Create an HTTP-based Telegram transport.
 * fetchImpl is injectable for testing.
 */
export function createHttpTransport(opts: {
	botToken: string;
	fetchImpl?: typeof fetch;
	/**
	 * Extra time beyond Telegram's server-side long-poll timeout before aborting
	 * a stuck getUpdates request. Injectable to keep timeout tests fast.
	 * Defaults to 10 seconds.
	 */
	getUpdatesTimeoutMarginMs?: number;
}): TelegramTransport {
	const {
		botToken,
		fetchImpl = globalThis.fetch,
		getUpdatesTimeoutMarginMs = 10_000,
	} = opts;

	/**
	 * Call a Telegram Bot API method with JSON body.
	 */
	async function callTelegram<TResponse>(
		method: string,
		body: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		const fetchOptions: RequestInit = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		};
		if (options?.signal) {
			fetchOptions.signal = options.signal;
		}

		const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, fetchOptions);

		const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description ?? `Telegram API ${method} failed`);
		}
		return data.result;
	}

	/**
	 * Call a Telegram Bot API method with multipart/form-data body.
	 */
	async function callTelegramMultipart<TResponse>(
		method: string,
		fields: Record<string, string>,
		fileField: string,
		filePath: string,
		fileName: string,
	): Promise<TResponse> {
		const form = new FormData();

		// Add text fields
		for (const [key, value] of Object.entries(fields)) {
			form.set(key, value);
		}

		// Add file
		const buffer = await readFile(filePath);
		form.set(fileField, new Blob([buffer]), fileName);

		const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
			method: "POST",
			body: form,
		});

		const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description ?? `Telegram API ${method} failed`);
		}
		return data.result;
	}

	return {
		async getMe() {
			return callTelegram<{ id: number; username?: string; is_bot: boolean; first_name: string }>(
				"getMe",
				{},
			);
		},

		async getUpdates(opts, signal) {
			const body: Record<string, unknown> = {};
			if (opts.offset !== undefined) body.offset = opts.offset;
			if (opts.timeout !== undefined) body.timeout = opts.timeout;

			// Telegram persists the allowed_updates setting per bot token when
			// the parameter is omitted ("previous setting is used"), so an
			// earlier client that restricted it would silently suppress
			// callback_query delivery while messages keep flowing. Always pin
			// the update types this bridge handles.
			body.allowed_updates = [
				"message",
				"edited_message",
				"channel_post",
				"edited_channel_post",
				"callback_query",
			];

			// Telegram's timeout is server-side only. Bound the client request too,
			// with enough margin for Telegram to answer after its long poll expires.
			const serverTimeoutMs = (opts.timeout ?? 0) * 1000;
			const deadlineSignal = AbortSignal.timeout(serverTimeoutMs + getUpdatesTimeoutMarginMs);
			const requestSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
			return callTelegram<TelegramUpdate[]>("getUpdates", body, { signal: requestSignal });
		},

		async sendMessage(opts) {
			const body: Record<string, unknown> = {
				chat_id: opts.chatId,
				text: opts.text,
			};
			if (opts.parseMode !== undefined) body.parse_mode = opts.parseMode;
			if (opts.replyMarkup !== undefined) body.reply_markup = opts.replyMarkup;

			return callTelegram<{ message_id: number }>("sendMessage", body);
		},

		async editMessageText(opts) {
			const body: Record<string, unknown> = {
				chat_id: opts.chatId,
				message_id: opts.messageId,
				text: opts.text,
			};
			if (opts.parseMode !== undefined) body.parse_mode = opts.parseMode;
			if (opts.replyMarkup !== undefined) body.reply_markup = opts.replyMarkup;

			await callTelegram<true>("editMessageText", body);
		},

		async sendRichMessage(opts) {
			return callTelegram<{ message_id: number }>("sendRichMessage", {
				chat_id: opts.chatId,
				rich_message: { markdown: opts.markdown },
			});
		},

		async editMessageRich(opts) {
			await callTelegram<true>("editMessageText", {
				chat_id: opts.chatId,
				message_id: opts.messageId,
				rich_message: { markdown: opts.markdown },
			});
		},

		async sendChatAction(opts) {
			const body: Record<string, unknown> = {
				chat_id: opts.chatId,
				action: opts.action,
			};

			await callTelegram<true>("sendChatAction", body);
		},

		async answerCallbackQuery(opts) {
			const body: Record<string, unknown> = {
				callback_query_id: opts.callbackQueryId,
			};
			if (opts.text !== undefined) body.text = opts.text;

			await callTelegram<true>("answerCallbackQuery", body);
		},

		async sendDocument(opts) {
			const fields: Record<string, string> = {
				chat_id: opts.chatId.toString(),
			};
			if (opts.caption !== undefined) fields.caption = opts.caption;

			return callTelegramMultipart<{ message_id: number }>(
				"sendDocument",
				fields,
				"document",
				opts.filePath,
				opts.fileName,
			);
		},

		async sendPhoto(opts) {
			const fields: Record<string, string> = {
				chat_id: opts.chatId.toString(),
			};
			if (opts.caption !== undefined) fields.caption = opts.caption;

			return callTelegramMultipart<{ message_id: number }>(
				"sendPhoto",
				fields,
				"photo",
				opts.filePath,
				opts.fileName,
			);
		},

		async downloadFile(opts) {
			// Step 1: Get file metadata
			const file = await callTelegram<TelegramGetFileResult>("getFile", {
				file_id: opts.fileId,
			});

			if (!file.file_path) {
				throw new Error("Telegram getFile returned no file_path");
			}

			// Step 2: Download file bytes
			const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
			const response = await fetchImpl(downloadUrl);

			if (!response.ok) {
				throw new Error(`Failed to download Telegram file: ${response.status}`);
			}

			// Step 3: Write to destination
			await mkdir(dirname(opts.destPath), { recursive: true });
			const arrayBuffer = await response.arrayBuffer();
			await writeFile(opts.destPath, Buffer.from(arrayBuffer));

			return opts.destPath;
		},
	};
}
