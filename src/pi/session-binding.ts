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
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentSessionPort, SessionStatus, ThinkingLevel } from "./session.js";

/**
 * Returns the latest ExtensionCommandContext, if any. Pi hands a fresh context
 * to each command handler; the bridge stores the most recent one so session
 * operations act on the live session.
 */
export type CommandContextGetter = () => ExtensionCommandContext | undefined;

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
	function requireCtx(): ExtensionCommandContext {
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
			await ctx.waitForIdle();
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

		async newSession(name?: string): Promise<{ cancelled: boolean }> {
			const ctx = requireCtx();
			const result = await ctx.newSession();
			if (!result.cancelled && name) {
				pi.setSessionName(name);
			}
			return result;
		},
	};
}
