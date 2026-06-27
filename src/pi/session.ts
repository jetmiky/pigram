/**
 * AgentSession adapter — the seam to the pi coding agent.
 *
 * This module defines a narrow port interface (AgentSessionPort) that pigram
 * depends on, and a structural driver interface (PiSessionDriver) that the
 * real pi ExtensionAPI/AgentSession satisfies. The adapter bridges the two
 * without requiring pigram to import pi at runtime.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface SessionStatus {
	modelId?: string;
	provider?: string;
	thinkingLevel: ThinkingLevel;
	busy: boolean;
}

export interface AgentSessionPort {
	getStatus(): SessionStatus;
	setModel(modelId: string): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): void;
	compact(): Promise<void>;
	abort(): Promise<void>;
	sendPrompt(text: string, imagePaths?: string[]): Promise<void>;
}

/**
 * Narrow structural type capturing only what we call on pi.
 * The real pi ExtensionAPI and AgentSession satisfy this interface
 * structurally, allowing tests to use fakes without importing pi.
 */
export interface PiSessionDriver {
	getThinkingLevel(): ThinkingLevel;
	setThinkingLevel(level: ThinkingLevel): void;
	readonly session: {
		readonly model?: { id: string; provider?: string };
		readonly isProcessing?: boolean;
		setModel(modelId: string): Promise<void>;
		compact(): Promise<unknown>;
		abort(): Promise<void>;
		prompt(text: string, options?: { images?: string[] }): Promise<void>;
	};
}

/**
 * Create an AgentSessionPort from a PiSessionDriver.
 * This adapter maps our port interface onto the driver, isolating pigram
 * from direct dependencies on pi's runtime types.
 */
export function createAgentSession(driver: PiSessionDriver): AgentSessionPort {
	return {
		getStatus(): SessionStatus {
			const model = driver.session.model;
			return {
				...(model?.id ? { modelId: model.id } : {}),
				...(model?.provider ? { provider: model.provider } : {}),
				thinkingLevel: driver.getThinkingLevel(),
				busy: driver.session.isProcessing ?? false,
			};
		},

		async setModel(modelId: string): Promise<void> {
			await driver.session.setModel(modelId);
		},

		setThinkingLevel(level: ThinkingLevel): void {
			driver.setThinkingLevel(level);
		},

		async compact(): Promise<void> {
			await driver.session.compact();
		},

		async abort(): Promise<void> {
			await driver.session.abort();
		},

		async sendPrompt(text: string, imagePaths?: string[]): Promise<void> {
			const options = imagePaths?.length ? { images: imagePaths } : undefined;
			await driver.session.prompt(text, options);
		},
	};
}
