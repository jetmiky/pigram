import { describe, test, expect } from "bun:test";
import pigram from "../src/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { telegramAskParameters } from "../src/telegram/ask.js";

/**
 * Fake pi ExtensionAPI that captures registrations instead of executing them.
 * pigram() is a composition root; at call time it only registers commands,
 * tools, and event handlers (all lazily invoked), so a capture fake can drive
 * the real production entrypoint without a live pi session.
 */
function makeFakePi() {
	const registeredTools: Array<Parameters<ExtensionAPI["registerTool"]>[0]> = [];
	const registeredCommands: Array<{ name: string; def: Parameters<ExtensionAPI["registerCommand"]>[1] }> = [];
	const events = new Set<string>();

	const registrations: Pick<ExtensionAPI, "registerTool" | "registerCommand" | "on"> = {
		registerTool(tool) {
			registeredTools.push(tool);
		},
		registerCommand(name, def) {
			registeredCommands.push({ name, def });
		},
		on(event) {
			events.add(event);

			return () => {};
		},
	};

	// SAFETY: the factory only registers capabilities; these tests never execute the captured handlers.
	const pi = registrations as ExtensionAPI;

	return { pi, registeredTools, registeredCommands, events };
}

describe("pigram production entrypoint", () => {
	test("registers telegram_ask as a sequential tool with the discriminated schema", () => {
		const { pi, registeredTools } = makeFakePi();
		pigram(pi);

		const ask = registeredTools.find((tool) => tool.name === "telegram_ask");
		expect(ask).toBeDefined();
		expect(ask?.executionMode).toBe("sequential");
		// TypeBox union of select | confirm | text
		expect(ask?.parameters).toEqual(telegramAskParameters);
		expect(telegramAskParameters.anyOf).toHaveLength(3);
		expect(ask?.description).toContain("Telegram");
	});

	test("registers the telegram lifecycle event handlers", () => {
		const { pi, events } = makeFakePi();
		pigram(pi);

		for (const event of ["session_start", "session_shutdown", "message_update", "agent_end"]) {
			expect(events.has(event), `expected ${event} handler`).toBe(true);
		}
	});
});
