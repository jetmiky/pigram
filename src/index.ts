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
import { markdownToTelegramHtml, chunkTelegramHtml, escapeTelegramHtml } from "./telegram/markdown.js";
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
import { extractAssistantText, type AgentMessageLike } from "./pi/assistant-text.js";

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
	// A Telegram-originated turn is "in flight" from the moment we submit the
	// prompt to pi until pi fires `agent_end`. pi.sendUserMessage only SUBMITS;
	// it does not await the turn, so we cannot use a try/finally around the
	// submit call to know when the reply is ready. Instead we track the active
	// turn here and clear it in the agent_end handler.
	let activeTurn: { chatId: number } | undefined;

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

	// --- Outbound senders ---
	// The bridge emits three distinct kinds of outbound text, and conflating them
	// is what caused literal "<pre>" / "&lt;" to leak into chat: a sender must
	// never re-escape text that is already in its final form.
	//
	//   sendPlain    — the bridge's own status/ack/error lines. No markup, so it
	//                  is sent verbatim with no parse mode (emoji are fine here).
	//   sendHtml     — text the bridge has ALREADY rendered to Telegram HTML
	//                  (e.g. the /help block with its <pre> and &lt; entities).
	//                  Sent as-is; converting it again would double-escape it.
	//   sendMarkdown — pi's assistant output, which is Markdown and must be
	//                  converted to Telegram HTML (honouring the richText flag).

	/** Send plain text the bridge generated itself. No markup interpretation. */
	async function sendPlain(chatId: number, text: string): Promise<void> {
		if (!transport) return;
		await transport.sendMessage({ chatId, text });
	}

	/** Send text that is already valid Telegram HTML. Never re-escaped. */
	async function sendHtml(chatId: number, html: string): Promise<void> {
		if (!transport) return;
		for (const chunk of chunkTelegramHtml(html)) {
			try {
				await transport.sendMessage({ chatId, text: chunk, parseMode: "HTML" });
			} catch {
				// Fall back to plain text if Telegram rejects the HTML.
				await transport.sendMessage({ chatId, text: chunk });
			}
		}
	}

	/** Send Markdown from pi's assistant output, converted to Telegram HTML. */
	async function sendMarkdown(chatId: number, markdown: string): Promise<void> {
		if (!transport) return;
		const richText = config?.ux?.richText ?? DEFAULT_UX.richText;
		if (!richText) {
			await sendPlain(chatId, markdown);
			return;
		}
		await sendHtml(chatId, markdownToTelegramHtml(markdown));
	}

	// --- Command handling (maps parsed intents to session/bridge actions) ---
	async function handleCommand(chatId: number, text: string): Promise<boolean> {
		const parsed = parseCommand(text);
		if (parsed === null) return false; // not a command

		switch (parsed.kind) {
			case "start":
			case "help": {
				await sendHtml(chatId, formatHelpReply({ includeBotFatherCommands: true }));
				return true;
			}
			case "status": {
				const s = session.getStatus();
				const model = `${s.provider ? `${s.provider}/` : ""}${s.modelId ?? "unknown"}`;
				const lines = [
					"📊 <b>Session status</b>",
					`🤖 Model: ${escapeTelegramHtml(model)}`,
					`🧠 Thinking: ${escapeTelegramHtml(s.thinkingLevel)}`,
					`${s.busy ? "⏳" : "✅"} State: ${s.busy ? "busy" : "idle"}`,
					`📥 Queued: ${followUps.size}`,
				];
				await sendHtml(chatId, lines.join("\n"));
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
					await sendPlain(chatId, `✅ Active model: ${s.provider ? `${s.provider}/` : ""}${s.modelId ?? parsed.model} · thinking: ${s.thinkingLevel}`);
				} catch (err) {
					await sendPlain(chatId, `⚠️ ${err instanceof Error ? err.message : String(err)}`);
				}
				return true;
			}
			case "thinking": {
				const level = asThinkingLevel(parsed.level);
				if (!level) {
					await sendPlain(chatId, `⚠️ Invalid thinking level: ${parsed.level}`);
					return true;
				}
				session.setThinkingLevel(level);
				await sendPlain(chatId, `🧠 Thinking: ${session.getStatus().thinkingLevel}`);
				return true;
			}
			case "compact": {
				await session.compact();
				await sendPlain(chatId, "🗜️ Compaction triggered");
				return true;
			}
			case "stop": {
				await session.abort();
				await sendPlain(chatId, "🛑 Aborted");
				return true;
			}
			case "new": {
				const result = await session.newSession(parsed.name);
				await sendPlain(chatId, result.cancelled ? "New session cancelled" : "🆕 Started a fresh pi session");
				return true;
			}
			case "resend": {
				await sendPlain(chatId, "Resend is not available in this build");
				return true;
			}
			case "git": {
				await sendPlain(chatId, parsed.git.ok ? `git ${parsed.git.kind}` : parsed.git.message);
				return true;
			}
			case "unknown":
			default: {
				await sendPlain(chatId, UNKNOWN_COMMAND_MESSAGE);
				return true;
			}
		}
	}

	// --- Inbound message routing ---
	async function routeMessage(chatId: number, userId: number, msg: InboundMessage): Promise<void> {
		// Pairing gate.
		const decision = decidePairing(pairing, userId);
		if (decision.kind === "reject") {
			await sendPlain(chatId, "🔒 This bot is paired with another user.");
			return;
		}
		if (decision.kind === "pair") {
			pairing = applyPairing(pairing, decision);
			await persistPairing();
			await sendPlain(chatId, "🔗 Telegram bridge paired with this account.");
		}
		activeChatId = chatId;

		// Dialog text capture takes priority.
		if (dialog?.handleText(msg.text ?? "")) return;

		// Slash command?
		if (msg.text && (await handleCommand(chatId, msg.text))) return;

		// Otherwise forward to pi as a prompt (queue if a turn is in flight).
		if (activeTurn) {
			followUps.enqueue(msg);
			return;
		}
		await deliverPrompt(chatId, msg);
	}

	async function deliverPrompt(chatId: number, msg: InboundMessage): Promise<void> {
		// Mark the turn in flight BEFORE submitting. pi.sendUserMessage returns
		// immediately; the reply arrives later via agent_end.
		activeTurn = { chatId };
		// A typing indicator gives the user liveness feedback while pi works.
		// (Token-by-token streaming previews are deferred: doing them safely
		// needs throttling + HTML-safe partials; see streaming.ts.)
		void transport?.sendChatAction({ chatId, action: "typing" }).catch(() => undefined);
		const mapped = mapInboundMessage(msg);
		await session.sendPrompt(mapped.text, mapped.imagePaths);
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
			"Create or write the file BEFORE calling telegram_attach. The tool reads the file immediately and fails with ENOENT if the path does not yet exist.",
			"Pass paths relative to the current working directory (or absolute paths). Do not attach a file you have only described but not yet written.",
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

	// --- Assistant reply forwarding ---
	// pi drives an asynchronous turn after pi.sendUserMessage. We mirror its
	// progress back to Telegram: message_update streams a live preview, and
	// agent_end delivers the final reply and releases the turn so queued
	// follow-ups can run.

	pi.on("agent_end", async (event) => {
		const turn = activeTurn;
		if (!turn) return;
		activeTurn = undefined;

		const outcome = extractAssistantText(event.messages as AgentMessageLike[]);

		if (outcome.stopReason === "aborted") {
			// User asked to stop; the /stop ack already covers it.
		} else if (outcome.stopReason === "error") {
			await sendPlain(turn.chatId, `⚠️ ${outcome.errorMessage ?? "pi failed while processing the request."}`);
		} else if (outcome.text) {
			await sendMarkdown(turn.chatId, outcome.text);
		}

		// Flush any attachments the assistant queued during the turn.
		if (transport) {
			await flushAttachments(attachments, transport, turn.chatId).catch(() => undefined);
		}

		// Drain one queued follow-up, if any, starting a fresh turn.
		const next = followUps.dequeue();
		if (next) await deliverPrompt(turn.chatId, next);
	});
}

/** Parse an optional "local"|"global" scope argument. */
function parseScopeArg(args: string): Scope | undefined {
	const token = args.trim().toLowerCase();
	if (token === "local" || token === "project") return "project";
	if (token === "global") return "global";
	return undefined;
}
