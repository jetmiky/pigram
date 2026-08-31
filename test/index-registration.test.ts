import { describe, test, expect } from "bun:test";
import pigram from "../src/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Fake pi ExtensionAPI that captures registrations instead of executing them.
 * pigram() is a composition root; at call time it only registers commands,
 * tools, and event handlers (all lazily invoked), so a capture fake can drive
 * the real production entrypoint without a live pi session.
 */
function makeFakePi() {
	const registeredTools: Array<Record<string, unknown>> = [];
	const registeredCommands: Array<{ name: string; def: Record<string, unknown> }> = [];
	const events = new Map<string, Array<(...args: never[]) => unknown>>();
	const pi = {
		registerTool(tool: Record<string, unknown>): void {
			registeredTools.push(tool);
		},
		registerCommand(name: string, def: Record<string, unknown>): void {
			registeredCommands.push({ name, def });
		},
		on(event: string, handler: (...args: never[]) => unknown): void {
			const list = events.get(event) ?? [];
			list.push(handler);
			events.set(event, list);
		},
	} as unknown as ExtensionAPI;
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
		const schema = ask?.parameters as { anyOf?: unknown[] } | undefined;
		expect(schema?.anyOf).toHaveLength(3);
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
