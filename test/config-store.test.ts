import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveScope, readConfig, writeConfig, readState, writeState, ensureProjectGitignore } from "../src/config/store.js";
import type { PigramConfig } from "../src/config/schema.js";

describe("ConfigStore", () => {
  let tempDir: string;
  let testCwd: string;
  let testHomeDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pigram-test-"));
    testCwd = join(tempDir, "project");
    testHomeDir = join(tempDir, "home");
    await mkdir(testCwd, { recursive: true });
    await mkdir(testHomeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("resolveScope", () => {
    test("defaults to project when no files exist", async () => {
      const result = await resolveScope({
        cwd: testCwd,
        homeDir: testHomeDir,
      });

      expect(result.scope).toBe("project");
      expect(result.configPath).toBe(join(testCwd, ".pi", "pigram.json"));
      expect(result.statePath).toBe(join(testCwd, ".pi", "tmp", "pigram", "state.json"));
      expect(result.tempDir).toBe(join(testCwd, ".pi", "tmp", "pigram"));
    });

    test("returns project when project config file exists", async () => {
      const projectConfigPath = join(testCwd, ".pi", "pigram.json");
      await mkdir(join(testCwd, ".pi"), { recursive: true });
      await writeFile(projectConfigPath, JSON.stringify({ botToken: "test" }));

      const result = await resolveScope({
        cwd: testCwd,
        homeDir: testHomeDir,
      });

      expect(result.scope).toBe("project");
      expect(result.configPath).toBe(projectConfigPath);
    });

    test("returns global when only global config file exists", async () => {
      const globalConfigPath = join(testHomeDir, ".pi", "agent", "pigram.json");
      await mkdir(join(testHomeDir, ".pi", "agent"), { recursive: true });
      await writeFile(globalConfigPath, JSON.stringify({ botToken: "test" }));

      const result = await resolveScope({
        cwd: testCwd,
        homeDir: testHomeDir,
      });

      expect(result.scope).toBe("global");
      expect(result.configPath).toBe(globalConfigPath);
      expect(result.statePath).toBe(join(testHomeDir, ".pi", "agent", "tmp", "pigram", "state.json"));
      expect(result.tempDir).toBe(join(testHomeDir, ".pi", "agent", "tmp", "pigram"));
    });

    test("returns project when scope is forced to project", async () => {
      const globalConfigPath = join(testHomeDir, ".pi", "agent", "pigram.json");
      await mkdir(join(testHomeDir, ".pi", "agent"), { recursive: true });
      await writeFile(globalConfigPath, JSON.stringify({ botToken: "test" }));

      const result = await resolveScope({
        cwd: testCwd,
        homeDir: testHomeDir,
        scope: "project",
      });

      expect(result.scope).toBe("project");
      expect(result.configPath).toBe(join(testCwd, ".pi", "pigram.json"));
    });

    test("returns global when scope is forced to global", async () => {
      const projectConfigPath = join(testCwd, ".pi", "pigram.json");
      await mkdir(join(testCwd, ".pi"), { recursive: true });
      await writeFile(projectConfigPath, JSON.stringify({ botToken: "test" }));

      const result = await resolveScope({
        cwd: testCwd,
        homeDir: testHomeDir,
        scope: "global",
      });

      expect(result.scope).toBe("global");
      expect(result.configPath).toBe(join(testHomeDir, ".pi", "agent", "pigram.json"));
    });
  });

  describe("readConfig and writeConfig", () => {
    test("roundtrips config correctly", async () => {
      const paths = await resolveScope({ cwd: testCwd, homeDir: testHomeDir });
      const config: PigramConfig = {
        botToken: "test-token-123",
        ux: {
          richText: false,
          streamPreviews: true,
        },
      };

      await writeConfig(paths, config);
      const readBack = await readConfig(paths);

      expect(readBack).not.toBeNull();
      expect(readBack?.botToken).toBe("test-token-123");
      expect(readBack?.ux?.richText).toBe(false);
      expect(readBack?.ux?.streamPreviews).toBe(true);
    });

    test("readConfig returns null when file is missing", async () => {
      const paths = await resolveScope({ cwd: testCwd, homeDir: testHomeDir });
      const result = await readConfig(paths);
      expect(result).toBeNull();
    });

    test("readConfig throws when file is invalid JSON", async () => {
      const paths = await resolveScope({ cwd: testCwd, homeDir: testHomeDir });
      await mkdir(join(testCwd, ".pi"), { recursive: true });
      await writeFile(paths.configPath, "{ invalid json");

      expect(async () => await readConfig(paths)).toThrow();
    });

    test("readConfig throws when file fails validation", async () => {
      const paths = await resolveScope({ cwd: testCwd, homeDir: testHomeDir });
      await mkdir(join(testCwd, ".pi"), { recursive: true });
      await writeFile(paths.configPath, JSON.stringify({ botToken: "" })); // empty token fails validation

      expect(async () => await readConfig(paths)).toThrow();
    });
  });

  describe("readState and writeState", () => {
    test("state is written to separate path, not in config file", async () => {
      const paths = await resolveScope({ cwd: testCwd, homeDir: testHomeDir });
      const config: PigramConfig = { botToken: "test-token" };
      const state = {
        lastUpdateId: 123,
        pairedUserId: 456,
        botId: 789,
        botUsername: "testbot",
      };

      await writeConfig(paths, config);
      await writeState(paths, state);

      // Config file should NOT contain state fields
      const configContent = await readFile(paths.configPath, "utf8");
      const configOnDisk = JSON.parse(configContent);
      expect(configOnDisk.lastUpdateId).toBeUndefined();
      expect(configOnDisk.pairedUserId).toBeUndefined();
      expect(configOnDisk.botId).toBeUndefined();
      expect(configOnDisk.botUsername).toBeUndefined();

      // State file should exist at the correct path
      const stateContent = await readFile(paths.statePath, "utf8");
      const stateOnDisk = JSON.parse(stateContent);
      expect(stateOnDisk.lastUpdateId).toBe(123);
      expect(stateOnDisk.pairedUserId).toBe(456);
      expect(stateOnDisk.botId).toBe(789);
      expect(stateOnDisk.botUsername).toBe("testbot");
    });

    test("readState returns default when file is missing", async () => {
      const paths = await resolveScope({ cwd: testCwd, homeDir: testHomeDir });
      const state = await readState(paths);
      expect(state.lastUpdateId).toBe(0);
      expect(state.pairedUserId).toBeUndefined();
      expect(state.botId).toBeUndefined();
      expect(state.botUsername).toBeUndefined();
    });

    test("writeState then readState roundtrips", async () => {
      const paths = await resolveScope({ cwd: testCwd, homeDir: testHomeDir });
      const state = {
        lastUpdateId: 999,
        pairedUserId: 111,
        botId: 222,
        botUsername: "mybot",
      };

      await writeState(paths, state);
      const readBack = await readState(paths);

      expect(readBack.lastUpdateId).toBe(999);
      expect(readBack.pairedUserId).toBe(111);
      expect(readBack.botId).toBe(222);
      expect(readBack.botUsername).toBe("mybot");
    });
  });

  describe("ensureProjectGitignore", () => {
    test("creates .gitignore with both entries", async () => {
      await ensureProjectGitignore(testCwd);

      const gitignorePath = join(testCwd, ".gitignore");
      const content = await readFile(gitignorePath, "utf8");

      expect(content).toContain(".pi/pigram.json");
      expect(content).toContain(".pi/tmp/");
    });

    test("running twice does not duplicate entries", async () => {
      await ensureProjectGitignore(testCwd);
      await ensureProjectGitignore(testCwd);

      const gitignorePath = join(testCwd, ".gitignore");
      const content = await readFile(gitignorePath, "utf8");

      // Count occurrences - should only appear once each
      const configCount = (content.match(/\.pi\/pigram\.json/g) || []).length;
      const tmpCount = (content.match(/\.pi\/tmp\//g) || []).length;

      expect(configCount).toBe(1);
      expect(tmpCount).toBe(1);
    });
  });
});
