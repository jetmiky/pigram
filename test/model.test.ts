import { test, expect, describe } from "bun:test";
import { resolveModelTarget, type ModelLookupModel, type ModelRegistryLookup } from "../src/domain/model.js";

// A fake registry over a fixed model list. `find` is exact provider+id.
function fakeRegistry(models: ModelLookupModel[]): ModelRegistryLookup<ModelLookupModel> {
	return {
		getAll: () => models,
		find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
	};
}

// Mirrors the real 9router setup: the model id itself contains a slash.
const REGISTRY = fakeRegistry([
	{ provider: "9router", id: "kr/claude-sonnet-4.5" },
	{ provider: "9router", id: "kr/claude-opus-4.8" },
	{ provider: "openai", id: "gpt-5" },
]);

describe("resolveModelTarget", () => {
	// The reported bug: a slash-containing model id under the current provider.
	test("resolves a slashed model id without a provider prefix, keeping the current provider", () => {
		const result = resolveModelTarget({
			registry: REGISTRY,
			currentProvider: "9router",
			specifier: "kr/claude-sonnet-4.5",
		});
		expect(result).toEqual({ ok: true, model: { provider: "9router", id: "kr/claude-sonnet-4.5" } });
	});

	test("resolves an explicit known-provider prefix, splitting only once", () => {
		const result = resolveModelTarget({
			registry: REGISTRY,
			currentProvider: "openai", // even with a different current provider
			specifier: "9router/kr/claude-sonnet-4.5",
		});
		expect(result).toEqual({ ok: true, model: { provider: "9router", id: "kr/claude-sonnet-4.5" } });
	});

	test("matches a provider prefix case-insensitively but uses the registry's canonical casing", () => {
		const result = resolveModelTarget({
			registry: REGISTRY,
			currentProvider: "openai",
			specifier: "9ROUTER/kr/claude-opus-4.8",
		});
		expect(result).toEqual({ ok: true, model: { provider: "9router", id: "kr/claude-opus-4.8" } });
	});

	test("resolves a bare model id with no slash under the current provider", () => {
		const result = resolveModelTarget({
			registry: REGISTRY,
			currentProvider: "openai",
			specifier: "gpt-5",
		});
		expect(result).toEqual({ ok: true, model: { provider: "openai", id: "gpt-5" } });
	});

	test("reports not found when a slashed id does not exist under the current provider", () => {
		const result = resolveModelTarget({
			registry: REGISTRY,
			currentProvider: "9router",
			specifier: "kr/nonexistent",
		});
		expect(result).toEqual({ ok: false, message: "model not found: kr/nonexistent" });
	});

	test("reports not found (with provider) when a known-provider prefix has no matching id", () => {
		const result = resolveModelTarget({
			registry: REGISTRY,
			currentProvider: "openai",
			specifier: "9router/kr/ghost",
		});
		expect(result).toEqual({
			ok: false,
			message: "model not found: 9router/kr/ghost (provider: 9router)",
		});
	});

	test("reports not found for a bare unknown id under the current provider", () => {
		const result = resolveModelTarget({
			registry: REGISTRY,
			currentProvider: "openai",
			specifier: "gpt-99",
		});
		expect(result).toEqual({ ok: false, message: "model not found: gpt-99" });
	});
});
