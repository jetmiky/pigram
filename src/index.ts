/**
 * Pigram — composition root.
 *
 * This is the thin wiring layer for the pi extension. It contains NO business
 * logic of its own: it resolves configuration, constructs the deep modules
 * (transport, poller, dialog manager, session binding, command dispatch), and
 * registers pi commands + the telegram_attach tool. All behavior lives in the
 * modules this file composes — the deletion test for index.ts is "removing it
 * loses only the wiring, not any logic".
 */
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	resolveScope,
	readConfig,
	writeConfig,
	readState,
	writeState,
	ensureProjectGitignore,
	type ResolvedPaths,
	type Scope,
} from "./config/store.js";
import { migrateLegacyConfig } from "./config/migrate.js";
import { DEFAULT_UX, type PigramConfig } from "./config/schema.js";
import { createHttpTransport, type TelegramTransport, type TelegramUpdate } from "./telegram/transport.js";
import { TelegramPoller } from "./telegram/poller.js";
import { DialogManager } from "./telegram/dialog.js";
import { markdownToTelegramHtml, chunkTelegramHtml } from "./telegram/markdown.js";
import { decidePairing, applyPairing, type PairingState } from "./domain/pairing.js";
import {
	parseCommand,
	formatHelpReply,
	formatBotFatherCommands,
	UNKNOWN_COMMAND_MESSAGE,
} from "./domain/commands.js";
import { mapInboundMessage, FollowUpQueue, type InboundMessage } from "./domain/prompt.js";
import { bindPiSession } from "./pi/session-binding.js";
import type { ThinkingLevel } from "./pi/session.js";
import { AttachmentQueue, flushAttachments, buildAttachToolParams, executeAttach } from "./pi/attach.js";

export const PIGRAM_VERSION = "0.1.0";

const POLL_ERROR_BACKOFF_MS = 1000;
const POLL_TIMEOUT_SECONDS = 30;

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Coerce arbitrary text to a valid ThinkingLevel, or undefined if not recognised. */
function asThinkingLevel(value: string): ThinkingLevel | undefined {
	return (THINKING_LEVELS as readonly string[]).includes(value) ? (value as ThinkingLevel) : undefined;
}

/**
 * The pi extension entrypoint. Pi calls this with its ExtensionAPI.
 */
export default function pigram(pi: ExtensionAPI): void {
	// --- Bridge runtime state (per pi session) ---
	let paths: ResolvedPaths | undefined;
	let config: PigramConfig | undefined;
	let pairing: PairingState = { pairedUserId: null };
	let transport: TelegramTransport | undefined;
	let dialog: DialogManager | undefined;
	let abortController: AbortController | undefined;
	let pollingActive = false;
	let activeChatId: number | undefined;
	let processing = false;

	const followUps = new FollowUpQueue();
	const attachments = new AttachmentQueue();
	let latestCtx: ExtensionCommandContext | undefined;
	const session = bindPiSession(pi, () => latestCtx);

	// --- Config + State persistence ---
	async function loadConfig(cwd: string, scope?: Scope): Promise<void> {
		paths = await resolveScope({ cwd, homeDir: homedir(), ...(scope ? { scope } : {}) });
		// Best-effort legacy migration before reading.
		const migrateScope: Scope = paths.scope;
		await migrateLegacyConfig({ cwd, homeDir: homedir(), scope: migrateScope }).catch(() => undefined);
		config = (await readConfig(paths)) ?? undefined;
		const state = await readState(paths);
		pairing = { pairedUserId: state.pairedUserId ?? null };
	}

	async function persistPairing(): Promise<void> {
		if (!paths) return;
		const state = await readState(paths);
		if (pairing.pairedUserId === null) {
			delete state.pairedUserId;
		} else {
			state.pairedUserId = pairing.pairedUserId;
		}
		await writeState(paths, state);
	}

	async function persistCursor(updateId: number): Promise<void> {
		if (!paths) return;
		const state = await readState(paths);
		state.lastUpdateId = updateId;
		await writeState(paths, state);
	}

	function getCursor(): number {
		return cursorCache;
	}
	let cursorCache = 0;

	// --- Outbound reply (rich text aware) ---
	async function sendReply(chatId: number, text: string): Promise<void> {
		if (!transport) return;
		const richText = config?.ux?.richText ?? DEFAULT_UX.richText;
		if (richText) {
			const html = markdownToTelegramHtml(text);
			for (const chunk of chunkTelegramHtml(html)) {
				try {
					await transport.sendMessage({ chatId, text: chunk, parseMode: "HTML" });
				} catch {
					// Fall back to plain text if HTML parsing fails on Telegram's side.
					await transport.sendMessage({ chatId, text: chunk });
				}
			}
		} else {
			await transport.sendMessage({ chatId, text });
		}
	}

	// --- Command handling (maps parsed intents to session/bridge actions) ---
	async function handleCommand(chatId: number, text: string): Promise<boolean> {
		const parsed = parseCommand(text);
		if (parsed === null) return false; // not a command

		switch (parsed.kind) {
			case "start":
			case "help": {
				await sendReply(chatId, formatHelpReply({ includeBotFatherCommands: true }));
				return true;
			}
			case "status": {
				const s = session.getStatus();
				const lines = [
					`model: ${s.provider ? `${s.provider}/` : ""}${s.modelId ?? "unknown"}`,
					`thinking: ${s.thinkingLevel}`,
					`state: ${s.busy ? "busy" : "idle"}`,
					`queued: ${followUps.size}`,
				];
				await sendReply(chatId, lines.join("\n"));
				return true;
			}
			case "model": {
				try {
					await session.setModel(parsed.model);
					if (parsed.thinking) {
						const level = asThinkingLevel(parsed.thinking);
						if (level) session.setThinkingLevel(level);
					}
					const s = session.getStatus();
					await sendReply(chatId, `active model: ${s.provider ? `${s.provider}/` : ""}${s.modelId ?? parsed.model}; thinking: ${s.thinkingLevel}`);
				} catch (err) {
					await sendReply(chatId, err instanceof Error ? err.message : String(err));
				}
				return true;
			}
			case "thinking": {
				const level = asThinkingLevel(parsed.level);
				if (!level) {
					await sendReply(chatId, `invalid thinking level: ${parsed.level}`);
					return true;
				}
				session.setThinkingLevel(level);
				await sendReply(chatId, `thinking: ${session.getStatus().thinkingLevel}`);
				return true;
			}
			case "compact": {
				await session.compact();
				await sendReply(chatId, "compaction triggered");
				return true;
			}
			case "stop": {
				await session.abort();
				await sendReply(chatId, "aborted");
				return true;
			}
			case "new": {
				const result = await session.newSession(parsed.name);
				await sendReply(chatId, result.cancelled ? "new session cancelled" : "started a fresh pi session");
				return true;
			}
			case "resend": {
				await sendReply(chatId, "resend is not available in this build");
				return true;
			}
			case "git": {
				await sendReply(chatId, parsed.git.ok ? `git ${parsed.git.kind}` : parsed.git.message);
				return true;
			}
			case "unknown":
			default: {
				await sendReply(chatId, UNKNOWN_COMMAND_MESSAGE);
				return true;
			}
		}
	}

	// --- Inbound message routing ---
	async function routeMessage(chatId: number, userId: number, msg: InboundMessage): Promise<void> {
		// Pairing gate.
		const decision = decidePairing(pairing, userId);
		if (decision.kind === "reject") {
			await sendReply(chatId, "This bot is paired with another user.");
			return;
		}
		if (decision.kind === "pair") {
			pairing = applyPairing(pairing, decision);
			await persistPairing();
			await sendReply(chatId, "Telegram bridge paired with this account.");
		}
		activeChatId = chatId;

		// Dialog text capture takes priority.
		if (dialog?.handleText(msg.text ?? "")) return;

		// Slash command?
		if (msg.text && (await handleCommand(chatId, msg.text))) return;

		// Otherwise forward to pi as a prompt (queue if busy).
		if (processing) {
			followUps.enqueue(msg);
			return;
		}
		await deliverPrompt(chatId, msg);
	}

	async function deliverPrompt(chatId: number, msg: InboundMessage): Promise<void> {
		processing = true;
		try {
			const mapped = mapInboundMessage(msg);
			await session.sendPrompt(mapped.text, mapped.imagePaths);
		} finally {
			processing = false;
		}
		// Drain any follow-ups queued while busy.
		const next = followUps.dequeue();
		if (next) await deliverPrompt(chatId, next);
	}

	async function onUpdate(update: TelegramUpdate): Promise<void> {
		cursorCache = update.update_id;
		if (update.callback_query && dialog) {
			await dialog.handleCallbackQuery(update.callback_query);
			return;
		}
		const message = update.message;
		if (!message || !message.from) return;
		const inbound: InboundMessage = {};
		if (message.text !== undefined) inbound.text = message.text;
		await routeMessage(message.chat.id, message.from.id, inbound);
	}

	// --- Polling lifecycle ---
	async function startPolling(): Promise<void> {
		if (!config?.botToken || pollingActive) return;
		transport = createHttpTransport({ botToken: config.botToken });
		const me = await transport.getMe();
		if (paths) {
			const state = await readState(paths);
			state.botId = me.id;
			if (me.username) state.botUsername = me.username;
			cursorCache = state.lastUpdateId;
			await writeState(paths, state);
		}
		abortController = new AbortController();
		pollingActive = true;
		const poller = new TelegramPoller({
			transport,
			handler: onUpdate,
			getCursor,
			setCursor: persistCursor,
			pollTimeoutSeconds: POLL_TIMEOUT_SECONDS,
			errorDelayMs: POLL_ERROR_BACKOFF_MS,
			onError: (err) => {
				latestCtx?.ui.setStatus("pigram", `error: ${err instanceof Error ? err.message : String(err)}`);
			},
		});
		void poller.start(abortController.signal).finally(() => {
			pollingActive = false;
		});
	}

	function stopPolling(): void {
		abortController?.abort();
		pollingActive = false;
	}

	// --- One-step setup ---
	async function runSetup(ctx: ExtensionCommandContext, scope?: Scope): Promise<void> {
		latestCtx = ctx;
		await loadConfig(ctx.cwd, scope);
		if (!paths) return;

		const token = (config?.botToken ?? (await ctx.ui.input("Telegram bot token", "123456:ABCDEF...")))?.trim();
		if (!token) {
			ctx.ui.notify("Setup cancelled: no token provided", "warning");
			return;
		}

		// Validate the token by calling getMe.
		const probe = createHttpTransport({ botToken: token });
		let username = "unknown";
		try {
			const me = await probe.getMe();
			username = me.username ?? "unknown";
		} catch (err) {
			ctx.ui.notify(`Invalid bot token: ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}

		config = { botToken: token, ux: { ...DEFAULT_UX } };
		await writeConfig(paths, config);
		if (paths.scope === "project") {
			await ensureProjectGitignore(ctx.cwd);
		}
		ctx.ui.notify(`Pigram connected: @${username}`, "info");
		ctx.ui.notify(`Config stored at ${paths.configPath}`, "info");
		ctx.ui.notify("Send /start to your bot in Telegram to pair this account.", "info");
		ctx.ui.notify(`BotFather /setcommands block:\n${formatBotFatherCommands()}`, "info");

		await startPolling();
	}

	// --- Register pi commands ---
	pi.registerCommand("pigram-setup", {
		description: "Configure the Pigram Telegram bridge (one-step setup)",
		handler: async (args, ctx) => {
			const scope = parseScopeArg(args);
			await runSetup(ctx, scope);
		},
	});

	pi.registerCommand("pigram-connect", {
		description: "Start the Pigram bridge in this pi session",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const scope = parseScopeArg(args);
			await loadConfig(ctx.cwd, scope);
			if (!config?.botToken) {
				await runSetup(ctx, scope);
				return;
			}
			await startPolling();
			ctx.ui.notify("Pigram bridge connected", "info");
		},
	});

	pi.registerCommand("pigram-disconnect", {
		description: "Stop the Pigram bridge in this pi session",
		handler: async (_args, ctx) => {
			stopPolling();
			ctx.ui.notify("Pigram bridge disconnected", "info");
		},
	});

	pi.registerCommand("pigram-status", {
		description: "Show Pigram bridge status",
		handler: async (_args, ctx) => {
			const lines = [
				`config: ${paths?.configPath ?? "not loaded"}`,
				`scope: ${paths?.scope ?? "n/a"}`,
				`paired user: ${pairing.pairedUserId ?? "not paired"}`,
				`polling: ${pollingActive ? "running" : "stopped"}`,
			];
			ctx.ui.notify(lines.join(" | "), "info");
		},
	});

	// --- Register the telegram_attach tool ---
	pi.registerTool({
		name: "telegram_attach",
		label: "Telegram Attach",
		description: "Queue one or more local files to be sent with the next Telegram reply.",
		promptSnippet: "Queue local files to be sent with the next Telegram reply.",
		promptGuidelines: [
			"When replying to a [telegram] message and the user asked for a file or generated artifact, call telegram_attach with the local path instead of only mentioning it in text.",
		],
		parameters: buildAttachToolParams(),
		async execute(_toolCallId, params) {
			const result = await executeAttach(params as { paths: string[] }, attachments);
			// Flush immediately if we know the active chat.
			if (transport && activeChatId !== undefined) {
				await flushAttachments(attachments, transport, activeChatId);
			}
			return {
				content: [{ type: "text", text: `Queued ${result.added.length} Telegram attachment(s).` }],
				details: { paths: result.added },
			};
		},
	});

	// Initialise the dialog manager lazily once a chat is known is handled inside
	// startPolling via transport; create it here bound to the active chat on first use.
	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx as unknown as ExtensionCommandContext;
		await loadConfig(ctx.cwd).catch(() => undefined);
		if (config?.botToken) {
			await startPolling().catch(() => undefined);
			if (transport && activeChatId !== undefined) {
				dialog = new DialogManager({ transport, chatId: activeChatId });
			}
		}
	});
}

/** Parse an optional "local"|"global" scope argument. */
function parseScopeArg(args: string): Scope | undefined {
	const token = args.trim().toLowerCase();
	if (token === "local" || token === "project") return "project";
	if (token === "global") return "global";
	return undefined;
}
