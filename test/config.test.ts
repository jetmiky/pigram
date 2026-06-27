import { describe, test, expect } from "bun:test";
import { validateConfig, DEFAULT_UX } from "../src/config/schema";

describe("PigramConfig validation", () => {
  test("valid minimal config (botToken only) applies UX defaults", () => {
    const input = { botToken: "123456:ABC-DEF" };
    const result = validateConfig(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.botToken).toBe("123456:ABC-DEF");
      expect(result.config.ux).toEqual({
        richText: true,
        streamPreviews: true,
      });
    }
  });

  test("valid full config with ux flags false preserves them", () => {
    const input = {
      botToken: "789:XYZ",
      ux: { richText: false, streamPreviews: false },
    };
    const result = validateConfig(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.botToken).toBe("789:XYZ");
      expect(result.config.ux).toEqual({
        richText: false,
        streamPreviews: false,
      });
    }
  });

  test("missing botToken is rejected", () => {
    const input = { ux: { richText: true } };
    const result = validateConfig(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((err) => err.includes("botToken"))).toBe(true);
    }
  });

  test("empty botToken string is rejected", () => {
    const input = { botToken: "" };
    const result = validateConfig(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  test("botToken as number is rejected", () => {
    const input = { botToken: 12345 };
    const result = validateConfig(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  test("ux.richText as non-boolean is rejected", () => {
    const input = { botToken: "valid-token", ux: { richText: "yes" } };
    const result = validateConfig(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  test("unknown top-level key is rejected", () => {
    const input = { botToken: "valid-token", unknownField: "value" };
    const result = validateConfig(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  test("unknown ux key is rejected", () => {
    const input = {
      botToken: "valid-token",
      ux: { richText: true, unknownUxField: "value" },
    };
    const result = validateConfig(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  test("partial ux object gets defaults for missing flags", () => {
    const input = { botToken: "token", ux: { richText: false } };
    const result = validateConfig(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.ux).toEqual({
        richText: false,
        streamPreviews: true, // defaulted
      });
    }
  });
});
