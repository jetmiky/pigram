import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * Minimal Telegram user shape.
 */
const TelegramUserSchema = Type.Object({
	id: Type.Integer({ minimum: 1 }),
	is_bot: Type.Boolean(),
	first_name: Type.String(),
	last_name: Type.Optional(Type.String()),
	username: Type.Optional(Type.String()),
});

export type TelegramUser = Static<typeof TelegramUserSchema>;

/**
 * Minimal Telegram chat shape.
 */
const TelegramChatSchema = Type.Object({
	id: Type.Integer(),
	type: Type.Union([Type.Literal("private"), Type.Literal("group"), Type.Literal("supergroup"), Type.Literal("channel")]),
	title: Type.Optional(Type.String()),
	username: Type.Optional(Type.String()),
	first_name: Type.Optional(Type.String()),
	last_name: Type.Optional(Type.String()),
});

export type TelegramChat = Static<typeof TelegramChatSchema>;

/**
 * Telegram photo size.
 */
const TelegramPhotoSizeSchema = Type.Object({
	file_id: Type.String(),
	file_unique_id: Type.String(),
	width: Type.Integer(),
	height: Type.Integer(),
	file_size: Type.Optional(Type.Integer()),
});

export type TelegramPhotoSize = Static<typeof TelegramPhotoSizeSchema>;

/**
 * Telegram document.
 */
const TelegramDocumentSchema = Type.Object({
	file_id: Type.String(),
	file_unique_id: Type.String(),
	file_name: Type.Optional(Type.String()),
	mime_type: Type.Optional(Type.String()),
	file_size: Type.Optional(Type.Integer()),
});

export type TelegramDocument = Static<typeof TelegramDocumentSchema>;

/**
 * Telegram voice message.
 */
const TelegramVoiceSchema = Type.Object({
	file_id: Type.String(),
	file_unique_id: Type.String(),
	duration: Type.Integer(),
	mime_type: Type.Optional(Type.String()),
	file_size: Type.Optional(Type.Integer()),
});

export type TelegramVoice = Static<typeof TelegramVoiceSchema>;

/**
 * Telegram message.
 */
const TelegramMessageSchema = Type.Object({
	message_id: Type.Integer(),
	from: Type.Optional(TelegramUserSchema),
	date: Type.Integer(),
	chat: TelegramChatSchema,
	text: Type.Optional(Type.String()),
	caption: Type.Optional(Type.String()),
	photo: Type.Optional(Type.Array(TelegramPhotoSizeSchema)),
	document: Type.Optional(TelegramDocumentSchema),
	voice: Type.Optional(TelegramVoiceSchema),
});

export type TelegramMessage = Static<typeof TelegramMessageSchema>;

/**
 * Telegram callback query (from inline keyboard button).
 */
const TelegramCallbackQuerySchema = Type.Object({
	id: Type.String(),
	from: TelegramUserSchema,
	message: Type.Optional(TelegramMessageSchema),
	data: Type.Optional(Type.String()),
});

export type TelegramCallbackQuery = Static<typeof TelegramCallbackQuerySchema>;

/**
 * Telegram update.
 */
const TelegramUpdateSchema = Type.Object({
	update_id: Type.Integer({ minimum: 0 }),
	message: Type.Optional(TelegramMessageSchema),
	callback_query: Type.Optional(TelegramCallbackQuerySchema),
});

export type TelegramUpdate = Static<typeof TelegramUpdateSchema>;

/**
 * Telegram Bot API response envelope.
 */
const TelegramApiResponseSchema = Type.Object({
	ok: Type.Boolean(),
	result: Type.Optional(Type.Unknown()),
	description: Type.Optional(Type.String()),
});

const TelegramMessageIdSchema = Type.Object({ message_id: Type.Integer() });
const TelegramEditResultSchema = Type.Union([TelegramMessageIdSchema, Type.Literal(true)]);

/**
 * Result of getFile API call.
 */
const TelegramGetFileResultSchema = Type.Object({
	file_id: Type.String(),
	file_unique_id: Type.String(),
	file_size: Type.Optional(Type.Integer()),
	file_path: Type.Optional(Type.String()),
});

async function readTelegramResponse<T extends TSchema>(response: Response, method: string, resultSchema: T): Promise<Static<T>> {
	const data: unknown = await response.json();

	if (!Value.Check(TelegramApiResponseSchema, data)) throw new Error(`Invalid Telegram API ${method} response`);

	if (!data.ok || data.result === undefined) throw new Error(data.description ?? `Telegram API ${method} failed`);

	if (!Value.Check(resultSchema, data.result)) throw new Error(`Invalid Telegram API ${method} result`);

	return data.result;
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

interface TelegramUpdatesBody {
	offset?: number;
	timeout?: number;
	allowed_updates?: string[];
}

interface TelegramMessageBody {
	chat_id: number;
	message_id?: number;
	text?: string;
	parse_mode?: "HTML";
	reply_markup?: unknown;
	rich_message?: { markdown: string };
	action?: "typing" | "upload_document" | "upload_photo";
}

interface TelegramCallbackBody {
	callback_query_id: string;
	text?: string;
}

interface TelegramFileFields {
	chat_id: string;
	caption?: string;
}

type TelegramRequestBody = TelegramUpdatesBody | TelegramMessageBody | TelegramCallbackBody | { file_id: string };

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
	async function callTelegram<T extends TSchema>(
		method: string,
		body: TelegramRequestBody,
		resultSchema: T,
		options?: { signal?: AbortSignal },
	): Promise<Static<T>> {
		const fetchOptions: RequestInit = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		};

		if (options?.signal) {
			fetchOptions.signal = options.signal;
		}

		const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, fetchOptions);

		return readTelegramResponse(response, method, resultSchema);
	}

	/**
	 * Call a Telegram Bot API method with multipart/form-data body.
	 */
	async function callTelegramMultipart(
		method: string,
		fields: TelegramFileFields,
		fileField: string,
		filePath: string,
		fileName: string,
	) {
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

		return readTelegramResponse(response, method, TelegramMessageIdSchema);
	}

	return {
		async getMe() {
			return callTelegram("getMe", {}, TelegramUserSchema);
		},

		async getUpdates(opts, signal) {
			const body: TelegramUpdatesBody = {};

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

			return callTelegram("getUpdates", body, Type.Array(TelegramUpdateSchema), { signal: requestSignal });
		},

		async sendMessage(opts) {
			const body: TelegramMessageBody = {
				chat_id: opts.chatId,
				text: opts.text,
			};

			if (opts.parseMode !== undefined) body.parse_mode = opts.parseMode;

			if (opts.replyMarkup !== undefined) body.reply_markup = opts.replyMarkup;

			return callTelegram("sendMessage", body, TelegramMessageIdSchema);
		},

		async editMessageText(opts) {
			const body: TelegramMessageBody = {
				chat_id: opts.chatId,
				message_id: opts.messageId,
				text: opts.text,
			};

			if (opts.parseMode !== undefined) body.parse_mode = opts.parseMode;

			if (opts.replyMarkup !== undefined) body.reply_markup = opts.replyMarkup;

			await callTelegram("editMessageText", body, TelegramEditResultSchema);
		},

		async sendRichMessage(opts) {
			return callTelegram("sendRichMessage", {
				chat_id: opts.chatId,
				rich_message: { markdown: opts.markdown },
			}, TelegramMessageIdSchema);
		},

		async editMessageRich(opts) {
			await callTelegram("editMessageText", {
				chat_id: opts.chatId,
				message_id: opts.messageId,
				rich_message: { markdown: opts.markdown },
			}, TelegramEditResultSchema);
		},

		async sendChatAction(opts) {
			const body: TelegramMessageBody = {
				chat_id: opts.chatId,
				action: opts.action,
			};

			await callTelegram("sendChatAction", body, Type.Literal(true));
		},

		async answerCallbackQuery(opts) {
			const body: TelegramCallbackBody = {
				callback_query_id: opts.callbackQueryId,
			};

			if (opts.text !== undefined) body.text = opts.text;

			await callTelegram("answerCallbackQuery", body, Type.Literal(true));
		},

		async sendDocument(opts) {
			const fields: TelegramFileFields = {
				chat_id: opts.chatId.toString(),
			};

			if (opts.caption !== undefined) fields.caption = opts.caption;

			return callTelegramMultipart(
				"sendDocument",
				fields,
				"document",
				opts.filePath,
				opts.fileName,
			);
		},

		async sendPhoto(opts) {
			const fields: TelegramFileFields = {
				chat_id: opts.chatId.toString(),
			};

			if (opts.caption !== undefined) fields.caption = opts.caption;

			return callTelegramMultipart(
				"sendPhoto",
				fields,
				"photo",
				opts.filePath,
				opts.fileName,
			);
		},

		async downloadFile(opts) {
			// Step 1: Get file metadata
			const file = await callTelegram("getFile", {
				file_id: opts.fileId,
			}, TelegramGetFileResultSchema);

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
