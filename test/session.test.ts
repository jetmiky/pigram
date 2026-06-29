import { describe, expect, test } from "bun:test";
import type { AgentSessionPort, PiSessionDriver, ThinkingLevel } from "../src/pi/session";
import { createAgentSession, sumAssistantUsage } from "../src/pi/session";

interface FakeSessionState {
	model?: { id: string; provider?: string };
	isProcessing: boolean;
	thinkingLevel: ThinkingLevel;
	calls: Array<{ method: string; args: unknown[] }>;
}

function createFakeDriver(state: FakeSessionState): PiSessionDriver {
	return {
		getThinkingLevel: () => state.thinkingLevel,
		setThinkingLevel: (level: ThinkingLevel) => {
			state.calls.push({ method: "setThinkingLevel", args: [level] });
			state.thinkingLevel = level;
		},
		session: {
			get model() {
				return state.model;
			},
			get isProcessing() {
				return state.isProcessing;
			},
			setModel: async (modelId: string) => {
				state.calls.push({ method: "session.setModel", args: [modelId] });
				state.model = { id: modelId, provider: "test-provider" };
			},
			compact: async () => {
				state.calls.push({ method: "session.compact", args: [] });
				return { success: true };
			},
			abort: async () => {
				state.calls.push({ method: "session.abort", args: [] });
			},
			prompt: async (text: string, options?: { images?: string[] }) => {
				state.calls.push({ method: "session.prompt", args: [text, options] });
			},
		},
	};
}

describe("AgentSession adapter", () => {
	test("getStatus reflects model, thinking level, and busy state", () => {
		const state: FakeSessionState = {
			model: { id: "claude-3-5-sonnet", provider: "anthropic" },
			isProcessing: true,
			thinkingLevel: "medium",
			calls: [],
		};
		const driver = createFakeDriver(state);
		const session = createAgentSession(driver);

		const status = session.getStatus();

		expect(status.modelId).toBe("claude-3-5-sonnet");
		expect(status.provider).toBe("anthropic");
		expect(status.thinkingLevel).toBe("medium");
		expect(status.busy).toBe(true);
	});

	test("getStatus handles missing model", () => {
		const state: FakeSessionState = {
			model: undefined,
			isProcessing: false,
			thinkingLevel: "off",
			calls: [],
		};
		const driver = createFakeDriver(state);
		const session = createAgentSession(driver);

		const status = session.getStatus();

		expect(status.modelId).toBeUndefined();
		expect(status.provider).toBeUndefined();
		expect(status.thinkingLevel).toBe("off");
		expect(status.busy).toBe(false);
	});

	test("getStatus defaults isProcessing to false when undefined", () => {
		const state: FakeSessionState = {
			model: undefined,
			isProcessing: false,
			thinkingLevel: "low",
			calls: [],
		};
		const driver = createFakeDriver(state);
		// Simulate isProcessing being undefined
		Object.defineProperty(driver.session, "isProcessing", {
			get: () => undefined,
		});
		const session = createAgentSession(driver);

		const status = session.getStatus();

		expect(status.busy).toBe(false);
	});

	test("setModel forwards to session.setModel", async () => {
		const state: FakeSessionState = {
			isProcessing: false,
			thinkingLevel: "minimal",
			calls: [],
		};
		const driver = createFakeDriver(state);
		const session = createAgentSession(driver);

		await session.setModel("gpt-4");

		expect(state.calls).toEqual([
			{ method: "session.setModel", args: ["gpt-4"] },
		]);
	});

	test("setThinkingLevel forwards to driver", () => {
		const state: FakeSessionState = {
			isProcessing: false,
			thinkingLevel: "low",
			calls: [],
		};
		const driver = createFakeDriver(state);
		const session = createAgentSession(driver);

		session.setThinkingLevel("high");

		expect(state.calls).toEqual([
			{ method: "setThinkingLevel", args: ["high"] },
		]);
		expect(state.thinkingLevel).toBe("high");
	});

	test("compact awaits session.compact", async () => {
		const state: FakeSessionState = {
			isProcessing: false,
			thinkingLevel: "minimal",
			calls: [],
		};
		const driver = createFakeDriver(state);
		const session = createAgentSession(driver);

		await session.compact();

		expect(state.calls).toEqual([
			{ method: "session.compact", args: [] },
		]);
	});

	test("abort forwards to session.abort", async () => {
		const state: FakeSessionState = {
			isProcessing: true,
			thinkingLevel: "medium",
			calls: [],
		};
		const driver = createFakeDriver(state);
		const session = createAgentSession(driver);

		await session.abort();

		expect(state.calls).toEqual([
			{ method: "session.abort", args: [] },
		]);
	});

	test("sendPrompt without images calls prompt with text only", async () => {
		const state: FakeSessionState = {
			isProcessing: false,
			thinkingLevel: "low",
			calls: [],
		};
		const driver = createFakeDriver(state);
		const session = createAgentSession(driver);

		await session.sendPrompt("Hello, pi!");

		expect(state.calls).toEqual([
			{ method: "session.prompt", args: ["Hello, pi!", undefined] },
		]);
	});

	test("sendPrompt with empty images array calls prompt with text only", async () => {
		const state: FakeSessionState = {
			isProcessing: false,
			thinkingLevel: "low",
			calls: [],
		};
		const driver = createFakeDriver(state);
		const session = createAgentSession(driver);

		await session.sendPrompt("Look at this", []);

		expect(state.calls).toEqual([
			{ method: "session.prompt", args: ["Look at this", undefined] },
		]);
	});

	test("sendPrompt with images calls prompt with options", async () => {
		const state: FakeSessionState = {
			isProcessing: false,
			thinkingLevel: "medium",
			calls: [],
		};
		const driver = createFakeDriver(state);
		const session = createAgentSession(driver);

		await session.sendPrompt("What do you see?", ["/tmp/image1.png", "/tmp/image2.jpg"]);

		expect(state.calls).toEqual([
			{
				method: "session.prompt",
				args: ["What do you see?", { images: ["/tmp/image1.png", "/tmp/image2.jpg"] }],
			},
		]);
	});
});

describe("sumAssistantUsage", () => {
	test("returns zeroed totals for an empty session", () => {
		expect(sumAssistantUsage([])).toEqual({ input: 0, output: 0 });
	});

	test("sums input and output across all assistant message entries", () => {
		const entries = [
			{ type: "message", message: { role: "assistant", usage: { input: 100, output: 10 } } },
			{ type: "message", message: { role: "assistant", usage: { input: 250, output: 25 } } },
		];
		expect(sumAssistantUsage(entries)).toEqual({ input: 350, output: 35 });
	});

	test("ignores user messages and non-message entries", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "hi" } },
			{ type: "message", message: { role: "assistant", usage: { input: 100, output: 10 } } },
			{ type: "model_change", provider: "anthropic", modelId: "claude" },
			{ type: "session_info", name: "my-session" },
		];
		expect(sumAssistantUsage(entries)).toEqual({ input: 100, output: 10 });
	});

	test("tolerates assistant messages missing usage fields", () => {
		const entries = [
			{ type: "message", message: { role: "assistant" } },
			{ type: "message", message: { role: "assistant", usage: { input: 5 } } },
		];
		expect(sumAssistantUsage(entries)).toEqual({ input: 5, output: 0 });
	});
});

