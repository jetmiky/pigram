/**
 * Real binding from pi's ExtensionAPI to our AgentSessionPort.
 *
 * The unit-tested `createAgentSession(driver)` in ./session.ts adapts a narrow
 * structural driver and is covered by fakes. This module builds the SAME port
 * from pi's actual API-centric ExtensionAPI/ExtensionContext surface, which is
 * shaped differently (pi.sendUserMessage, pi.setModel(Model), ctx.isIdle(),
 * ctx.compact(), ctx.abort()).
 *
 * This file is validated by the end-to-end smoke test against a real pi
 * session, because it only exists to translate pigram's port onto pi's
 * concrete runtime objects.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentSessionPort, SessionStatus, ThinkingLevel } from "./session.js";
import { sumAssistantUsage } from "./session.js";

/**
 * Returns the latest pi event context, if any. Pi hands a context to every
 * event handler; the bridge stores the most recent so session operations act
 * on the live session.
 *
 * NOTE: this is the plain ExtensionContext (event context), NOT the
 * ExtensionCommandContext. Session-replacement methods (newSession, fork,
 * waitForIdle) exist only on the command context and are intentionally NOT
 * used here — those are handled in the composition root with a context
 * captured from an actual command handler.
 */
export type CommandContextGetter = () => ExtensionContext | undefined;

const MIME_BY_EXT: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
	".gif": "image/gif",
};

function mimeFromPath(path: string): string {
	return MIME_BY_EXT[extname(path).toLowerCase()] ?? "image/jpeg";
}

async function toImageContent(path: string): Promise<ImageContent> {
	const bytes = await readFile(path);
	return {
		type: "image",
		data: bytes.toString("base64"),
		mimeType: mimeFromPath(path),
	};
}

/**
 * Build an AgentSessionPort backed by the real pi ExtensionAPI.
 *
 * @param pi - the pi extension API handed to the extension entrypoint
 * @param getCtx - returns the latest ExtensionCommandContext, if any
 */
export function bindPiSession(pi: ExtensionAPI, getCtx: CommandContextGetter): AgentSessionPort {
	function requireCtx(): ExtensionContext {
		const ctx = getCtx();
		if (!ctx) throw new Error("No active pi session context");
		return ctx;
	}

	return {
		getStatus(): SessionStatus {
			const ctx = getCtx();
			const model = ctx?.model;
			const status: SessionStatus = {
				thinkingLevel: pi.getThinkingLevel() as ThinkingLevel,
				busy: ctx ? !ctx.isIdle() : false,
			};
			if (model?.id) status.modelId = model.id;
			if (model?.provider) status.provider = model.provider;
			if (ctx) {
				const sessionName = ctx.sessionManager.getSessionName();
				if (sessionName) status.sessionName = sessionName;
				if (ctx.cwd) status.cwd = ctx.cwd;
				const contextUsage = ctx.getContextUsage();
				if (contextUsage) status.contextUsage = contextUsage;
				status.usage = sumAssistantUsage(ctx.sessionManager.getEntries());
			}
			return status;
		},

		async setModel(modelId: string): Promise<void> {
			const ctx = requireCtx();
			// Accept "provider/id" or bare "id"; resolve against the registry.
			const slash = modelId.indexOf("/");
			const provider = slash > 0 ? modelId.slice(0, slash) : (ctx.model?.provider ?? "");
			const id = slash > 0 ? modelId.slice(slash + 1) : modelId;
			const resolved = ctx.modelRegistry.find(provider, id);
			if (!resolved) throw new Error(`Unknown model: ${modelId}`);
			const ok = await pi.setModel(resolved);
			if (!ok) throw new Error(`No API key available for model: ${modelId}`);
		},

		setThinkingLevel(level: ThinkingLevel): void {
			pi.setThinkingLevel(level);
		},

		async compact(): Promise<void> {
			const ctx = requireCtx();
			// waitForIdle() is command-context-only; the event context exposes a
			// synchronous isIdle() instead. Compaction during streaming is
			// rejected by pi anyway, so we surface a clear error rather than
			// silently no-op.
			if (!ctx.isIdle()) {
				throw new Error("Cannot compact while pi is busy — send /stop first.");
			}
			// ctx.compact() triggers compaction without awaiting completion.
			ctx.compact();
		},

		async abort(): Promise<void> {
			// ctx.abort() is synchronous and a no-op when not streaming.
			getCtx()?.abort();
		},

		async sendPrompt(text: string, imagePaths?: string[]): Promise<void> {
			if (imagePaths && imagePaths.length > 0) {
				const images = await Promise.all(imagePaths.map(toImageContent));
				const content: (TextContent | ImageContent)[] = [{ type: "text", text }, ...images];
				pi.sendUserMessage(content);
			} else {
				pi.sendUserMessage(text);
			}
		},
	};
}
