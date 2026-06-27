import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateLegacyConfig,
  legacyPaths,
  type MigrationResult,
} from "../src/config/migrate.js";
import { readConfig, readState } from "../src/config/store.js";

describe("legacyPaths", () => {
  it("returns project legacy path", () => {
    const result = legacyPaths({
      cwd: "/proj",
      homeDir: "/home/user",
      scope: "project",
    });
    expect(result.legacyConfigPath).toBe("/proj/.pi/telegram.json");
  });

  it("returns global legacy path", () => {
    const result = legacyPaths({
      cwd: "/proj",
      homeDir: "/home/user",
      scope: "global",
    });
    expect(result.legacyConfigPath).toBe("/home/user/.pi/agent/telegram.json");
  });
});

describe("migrateLegacyConfig", () => {
  let tempDir: string;
  let cwd: string;
  let homeDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pigram-test-"));
    cwd = join(tempDir, "project");
    homeDir = join(tempDir, "home");
    await mkdir(cwd, { recursive: true });
    await mkdir(homeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("no legacy file", () => {
    it("returns no-legacy status", async () => {
      const result = await migrateLegacyConfig({
        cwd,
        homeDir,
        scope: "project",
      });

      expect(result).toEqual({ status: "no-legacy" });
    });

    it("does not write any files", async () => {
      await migrateLegacyConfig({ cwd, homeDir, scope: "project" });

      // Verify no pigram.json or state.json created
      const configExists = await fileExists(join(cwd, ".pi", "pigram.json"));
      const stateExists = await fileExists(
        join(cwd, ".pi", "tmp", "pigram", "state.json")
      );
      expect(configExists).toBe(false);
      expect(stateExists).toBe(false);
    });
  });

  describe("legacy with full data", () => {
    it("migrates to new format with correct split", async () => {
      // Create legacy file with all fields
      const legacyPath = join(cwd, ".pi", "telegram.json");
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(
        legacyPath,
        JSON.stringify({
          botToken: "test-token-123",
          botUsername: "test_bot",
          botId: 123456789,
          allowedUserId: 987654321,
          lastUpdateId: 42,
          streamPreviews: false,
          richText: false,
        }),
        "utf8"
      );

      const result = await migrateLegacyConfig({
        cwd,
        homeDir,
        scope: "project",
      });

      expect(result.status).toBe("migrated");
      if (result.status === "migrated") {
        expect(result.configPath).toBe(join(cwd, ".pi", "pigram.json"));
        expect(result.statePath).toBe(
          join(cwd, ".pi", "tmp", "pigram", "state.json")
        );
      }
    });

    it("writes correct Config without state fields", async () => {
      const legacyPath = join(cwd, ".pi", "telegram.json");
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(
        legacyPath,
        JSON.stringify({
          botToken: "test-token-123",
          botUsername: "test_bot",
          botId: 123456789,
          allowedUserId: 987654321,
          lastUpdateId: 42,
          streamPreviews: false,
          richText: false,
        }),
        "utf8"
      );

      await migrateLegacyConfig({ cwd, homeDir, scope: "project" });

      const config = await readConfig({
        scope: "project",
        configPath: join(cwd, ".pi", "pigram.json"),
        statePath: join(cwd, ".pi", "tmp", "pigram", "state.json"),
        tempDir: join(cwd, ".pi", "tmp", "pigram"),
      });

      expect(config).toEqual({
        botToken: "test-token-123",
        ux: {
          richText: false,
          streamPreviews: false,
        },
      });
    });

    it("writes correct State with runtime fields", async () => {
      const legacyPath = join(cwd, ".pi", "telegram.json");
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(
        legacyPath,
        JSON.stringify({
          botToken: "test-token-123",
          botUsername: "test_bot",
          botId: 123456789,
          allowedUserId: 987654321,
          lastUpdateId: 42,
          streamPreviews: false,
          richText: false,
        }),
        "utf8"
      );

      await migrateLegacyConfig({ cwd, homeDir, scope: "project" });

      const state = await readState({
        scope: "project",
        configPath: join(cwd, ".pi", "pigram.json"),
        statePath: join(cwd, ".pi", "tmp", "pigram", "state.json"),
        tempDir: join(cwd, ".pi", "tmp", "pigram"),
      });

      expect(state).toEqual({
        lastUpdateId: 42,
        pairedUserId: 987654321,
        botId: 123456789,
        botUsername: "test_bot",
      });
    });

    it("leaves legacy file unchanged", async () => {
      const legacyPath = join(cwd, ".pi", "telegram.json");
      await mkdir(join(cwd, ".pi"), { recursive: true });
      const legacyContent = JSON.stringify({
        botToken: "test-token-123",
        botUsername: "test_bot",
        botId: 123456789,
        allowedUserId: 987654321,
        lastUpdateId: 42,
        streamPreviews: false,
        richText: false,
      });
      await writeFile(legacyPath, legacyContent, "utf8");

      await migrateLegacyConfig({ cwd, homeDir, scope: "project" });

      const afterContent = await readFile(legacyPath, "utf8");
      expect(afterContent).toBe(legacyContent);
    });
  });

  describe("legacy with minimal data (only botToken)", () => {
    it("migrates successfully with defaults", async () => {
      const legacyPath = join(cwd, ".pi", "telegram.json");
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(
        legacyPath,
        JSON.stringify({ botToken: "minimal-token" }),
        "utf8"
      );

      const result = await migrateLegacyConfig({
        cwd,
        homeDir,
        scope: "project",
      });

      expect(result.status).toBe("migrated");
    });

    it("applies default ux preferences", async () => {
      const legacyPath = join(cwd, ".pi", "telegram.json");
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(
        legacyPath,
        JSON.stringify({ botToken: "minimal-token" }),
        "utf8"
      );

      await migrateLegacyConfig({ cwd, homeDir, scope: "project" });

      const config = await readConfig({
        scope: "project",
        configPath: join(cwd, ".pi", "pigram.json"),
        statePath: join(cwd, ".pi", "tmp", "pigram", "state.json"),
        tempDir: join(cwd, ".pi", "tmp", "pigram"),
      });

      expect(config?.ux).toEqual({
        richText: true,
        streamPreviews: true,
      });
    });

    it("creates State with lastUpdateId 0", async () => {
      const legacyPath = join(cwd, ".pi", "telegram.json");
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(
        legacyPath,
        JSON.stringify({ botToken: "minimal-token" }),
        "utf8"
      );

      await migrateLegacyConfig({ cwd, homeDir, scope: "project" });

      const state = await readState({
        scope: "project",
        configPath: join(cwd, ".pi", "pigram.json"),
        statePath: join(cwd, ".pi", "tmp", "pigram", "state.json"),
        tempDir: join(cwd, ".pi", "tmp", "pigram"),
      });

      expect(state.lastUpdateId).toBe(0);
      expect(state.pairedUserId).toBeUndefined();
      expect(state.botId).toBeUndefined();
      expect(state.botUsername).toBeUndefined();
    });
  });

  describe("new pigram.json already exists", () => {
    it("returns skipped-existing status", async () => {
      // Create both legacy and new config
      const legacyPath = join(cwd, ".pi", "telegram.json");
      const newConfigPath = join(cwd, ".pi", "pigram.json");
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(
        legacyPath,
        JSON.stringify({ botToken: "legacy-token" }),
        "utf8"
      );
      await writeFile(
        newConfigPath,
        JSON.stringify({
          botToken: "existing-token",
          ux: { richText: true, streamPreviews: true },
        }),
        "utf8"
      );

      const result = await migrateLegacyConfig({
        cwd,
        homeDir,
        scope: "project",
      });

      expect(result).toEqual({ status: "skipped-existing" });
    });

    it("does not overwrite existing config", async () => {
      const legacyPath = join(cwd, ".pi", "telegram.json");
      const newConfigPath = join(cwd, ".pi", "pigram.json");
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(
        legacyPath,
        JSON.stringify({ botToken: "legacy-token" }),
        "utf8"
      );
      const existingConfig = JSON.stringify({
        botToken: "existing-token",
        ux: { richText: true, streamPreviews: true },
      });
      await writeFile(newConfigPath, existingConfig, "utf8");

      await migrateLegacyConfig({ cwd, homeDir, scope: "project" });

      const afterContent = await readFile(newConfigPath, "utf8");
      expect(afterContent).toBe(existingConfig);
    });
  });

  describe("legacy missing botToken", () => {
    it("returns error status", async () => {
      const legacyPath = join(cwd, ".pi", "telegram.json");
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(
        legacyPath,
        JSON.stringify({
          botUsername: "test_bot",
          lastUpdateId: 10,
        }),
        "utf8"
      );

      const result = await migrateLegacyConfig({
        cwd,
        homeDir,
        scope: "project",
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.message).toContain("botToken");
      }
    });

    it("does not write any files", async () => {
      const legacyPath = join(cwd, ".pi", "telegram.json");
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(
        legacyPath,
        JSON.stringify({
          botUsername: "test_bot",
          lastUpdateId: 10,
        }),
        "utf8"
      );

      await migrateLegacyConfig({ cwd, homeDir, scope: "project" });

      const configExists = await fileExists(join(cwd, ".pi", "pigram.json"));
      const stateExists = await fileExists(
        join(cwd, ".pi", "tmp", "pigram", "state.json")
      );
      expect(configExists).toBe(false);
      expect(stateExists).toBe(false);
    });
  });

  describe("global scope migration", () => {
    it("migrates to global paths", async () => {
      const legacyPath = join(homeDir, ".pi", "agent", "telegram.json");
      await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
      await writeFile(
        legacyPath,
        JSON.stringify({ botToken: "global-token" }),
        "utf8"
      );

      const result = await migrateLegacyConfig({
        cwd,
        homeDir,
        scope: "global",
      });

      expect(result.status).toBe("migrated");
      if (result.status === "migrated") {
        expect(result.configPath).toBe(
          join(homeDir, ".pi", "agent", "pigram.json")
        );
        expect(result.statePath).toBe(
          join(homeDir, ".pi", "agent", "tmp", "pigram", "state.json")
        );
      }
    });
  });
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
