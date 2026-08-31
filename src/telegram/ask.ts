import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TelegramCallbackQuery, TelegramTransport } from "./transport.js";

export const telegramAskParameters = Type.Union([
	Type.Object({
		kind: Type.Literal("select"),
		question: Type.String(),
		options: Type.Array(Type.Object({ label: Type.String(), value: Type.String() }), { minItems: 1 }),
		timeoutSeconds: Type.Optional(Type.Number({ minimum: 15, maximum: 900 })),
	}),
	Type.Object({
		kind: Type.Literal("confirm"),
		question: Type.String(),
		timeoutSeconds: Type.Optional(Type.Number({ minimum: 15, maximum: 900 })),
	}),
	Type.Object({
		kind: Type.Literal("text"),
		question: Type.String(),
		timeoutSeconds: Type.Optional(Type.Number({ minimum: 15, maximum: 900 })),
	}),
]);

export type TelegramAskToolParams = Static<typeof telegramAskParameters>;
export type TelegramAskOutcome =
	| { status: "answered"; value: string | boolean }
	| { status: "cancelled" }
	| { status: "timeout" }
	| { status: "unavailable"; reason: "not_telegram_turn" | "dialog_pending" };

type Transport = Pick<TelegramTransport, "sendMessage" | "editMessageText" | "answerCallbackQuery">;
type TurnOwner = { chatId: number; userId: number };
type ResponseOrigin = { chatId: number; userId: number };
type Pending = {
	id: string;
	owner: TurnOwner;
	params: TelegramAskToolParams;
	messageId: Promise<number>;
	resolve: (outcome: TelegramAskOutcome) => void;
	settled: boolean;
	timer?: ReturnType<typeof setTimeout>;
	onAbort: (() => void) | undefined;
};

const DEFAULT_TIMEOUT_SECONDS = 300;
const MIN_TIMEOUT_SECONDS = 15;
const MAX_TIMEOUT_SECONDS = 900;

function result(outcome: TelegramAskOutcome) {
	return { content: [{ type: "text" as const, text: JSON.stringify(outcome) }], details: outcome };
}

/** Coordinates one Telegram-native question with the currently running turn. */
export class TelegramAskController {
	private readonly transport: Transport;
	private readonly idGen: () => string;
	private readonly timeoutMsOverride: number | undefined;
	private turn: TurnOwner | undefined;
	private pending: Pending | undefined;
	private counter = 0;

	constructor(deps: { transport: Transport; idGen?: () => string; timeoutMs?: number }) {
		this.transport = deps.transport;
		this.idGen = deps.idGen ?? (() => `telegram_ask_${++this.counter}`);
		this.timeoutMsOverride = deps.timeoutMs;
	}

	beginTurn(owner: TurnOwner): void {
		this.cancel();
		this.turn = owner;
	}

	endTurn(): void {
		this.turn = undefined;
	}

	cancel(): void {
		const pending = this.pending;
		if (!pending) return;
		this.finish(pending, { status: "cancelled" }, "❌ Cancelled");
	}

	handleText(text: string, origin: ResponseOrigin): boolean {
		const pending = this.pending;
		if (!pending || pending.params.kind !== "text") return false;
		if (!this.authorized(pending, origin)) return false;
		this.finish(pending, { status: "answered", value: text }, "✓ Answer received");
		return true;
	}

	async handleCallbackQuery(query: TelegramCallbackQuery): Promise<boolean> {
		const data = query.data;
		if (!data) return false;
		const [id, indexText, extra] = data.split(":");
		if (!id || indexText === undefined || extra !== undefined || !/^\d+$/.test(indexText)) return false;

		const pending = this.pending;
		if (!pending || pending.id !== id) {
			await this.answer(query.id, "Dialog expired");
			return true;
		}
		if (!this.authorized(pending, {
			chatId: query.message?.chat.id ?? Number.NaN,
			userId: query.from.id,
		})) {
			await this.answer(query.id, "Not authorized");
			return true;
		}
		if (pending.params.kind === "text") {
			await this.answer(query.id, "This dialog expects text");
			return true;
		}
		const options = pending.params.kind === "confirm"
			? [{ label: "Yes", value: true }, { label: "No", value: false }]
			: pending.params.options;
		const chosen = options[Number(indexText)];
		if (!chosen) {
			await this.answer(query.id, "Dialog expired");
			return true;
		}

		// Answer first. Telegram stops showing the spinner even if cleanup fails.
		await this.answer(query.id);
		const outcome: TelegramAskOutcome = { status: "answered", value: chosen.value };
		this.finish(pending, outcome, `✓ ${chosen.label}`);
		return true;
	}

	ask(params: TelegramAskToolParams, signal?: AbortSignal): Promise<TelegramAskOutcome> {
		this.validate(params);
		if (!this.turn) return Promise.resolve({ status: "unavailable", reason: "not_telegram_turn" });
		if (this.pending) return Promise.resolve({ status: "unavailable", reason: "dialog_pending" });

		const id = this.idGen();
		const owner = this.turn;
		const text = params.question;
		const replyMarkup = params.kind === "select"
			? { inline_keyboard: params.options.map((option, index) => [{ text: option.label, callback_data: `${id}:${index}` }]) }
			: params.kind === "confirm"
				? { inline_keyboard: [[{ text: "Yes", callback_data: `${id}:0` }], [{ text: "No", callback_data: `${id}:1` }]] }
				: undefined;
		const messageId = this.transport.sendMessage({
			chatId: owner.chatId,
			text,
			...(replyMarkup ? { replyMarkup } : {}),
		}).then((message) => message.message_id);

		return new Promise<TelegramAskOutcome>((resolve, reject) => {
			const pending: Pending = { id, owner, params, messageId, resolve, settled: false, onAbort: undefined };
			this.pending = pending;
			const timeoutMs = this.timeoutMsOverride ?? (params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
			pending.timer = setTimeout(() => this.finish(pending, { status: "timeout" }, "⌛ Timed out"), timeoutMs);
			if (signal) {
				const onAbort = () => this.finish(pending, { status: "cancelled" }, "❌ Cancelled");
				pending.onAbort = onAbort;
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
			messageId.catch((error) => {
				if (this.pending === pending) this.pending = undefined;
				if (pending.timer) clearTimeout(pending.timer);
				if (pending.onAbort && signal) signal.removeEventListener("abort", pending.onAbort);
				reject(error);
			});
		});
	}

	private validate(params: TelegramAskToolParams): void {
		if (params.kind === "select" && params.options.length === 0) throw new Error("select requires at least one option");
		if (params.kind !== "select" && "options" in params && params.options !== undefined) {
			throw new Error(`${params.kind} does not accept options`);
		}
		if (params.timeoutSeconds !== undefined &&
			(!Number.isFinite(params.timeoutSeconds) || params.timeoutSeconds < MIN_TIMEOUT_SECONDS || params.timeoutSeconds > MAX_TIMEOUT_SECONDS)) {
			throw new Error("timeoutSeconds must be between 15 and 900");
		}
	}

	private authorized(pending: Pending, origin: ResponseOrigin): boolean {
		return pending.owner.chatId === origin.chatId && pending.owner.userId === origin.userId;
	}

	private async answer(callbackQueryId: string, text?: string): Promise<void> {
		await this.transport.answerCallbackQuery({ callbackQueryId, ...(text ? { text } : {}) });
	}

	private finish(pending: Pending, outcome: TelegramAskOutcome, suffix: string): void {
		if (pending.settled) return;
		pending.settled = true;
		if (this.pending === pending) this.pending = undefined;
		if (pending.timer) clearTimeout(pending.timer);
		if (pending.onAbort) pending.onAbort = undefined;
		void pending.messageId.then((messageId) => this.transport.editMessageText({
			chatId: pending.owner.chatId,
			messageId,
			text: `${pending.params.question}\n${suffix}`,
			replyMarkup: { inline_keyboard: [] },
		})).catch(() => undefined);
		pending.resolve(outcome);
	}
}

export function createTelegramAskTool(
		getController: (() => TelegramAskController | undefined) | TelegramAskController,
): ToolDefinition<typeof telegramAskParameters, TelegramAskOutcome> {
	const resolveController = typeof getController === "function" ? getController : () => getController;
	return {
		name: "telegram_ask",
		label: "Telegram Ask",
		description: "Ask the paired Telegram user a native select, confirmation, or text question during a Telegram turn.",
		promptSnippet: "Ask the paired Telegram user a native question.",
		promptGuidelines: ["Use only when the user is interacting through Telegram; terminal turns receive an unavailable result."],
		parameters: telegramAskParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const controller = resolveController();
			if (!controller) return result({ status: "unavailable", reason: "not_telegram_turn" });
			return result(await controller.ask(params, signal));
		},
	};
}

export function registerTelegramAskTool(pi: ExtensionAPI, getController: () => TelegramAskController | undefined): void {
	pi.registerTool(createTelegramAskTool(getController));
}
