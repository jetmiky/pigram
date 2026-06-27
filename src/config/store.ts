import { join } from "node:path";
import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import type { PigramConfig } from "./schema.js";
import { validateConfig } from "./schema.js";

export type Scope = "project" | "global";

export interface PigramState {
  lastUpdateId: number;
  pairedUserId?: number;
  botId?: number;
  botUsername?: string;
}

export interface ResolvedPaths {
  scope: Scope;
  configPath: string;
  statePath: string;
  tempDir: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function getProjectPaths(cwd: string): ResolvedPaths {
  const configPath = join(cwd, ".pi", "pigram.json");
  const tempDir = join(cwd, ".pi", "tmp", "pigram");
  const statePath = join(tempDir, "state.json");
  return { scope: "project", configPath, statePath, tempDir };
}

function getGlobalPaths(homeDir: string): ResolvedPaths {
  const configPath = join(homeDir, ".pi", "agent", "pigram.json");
  const tempDir = join(homeDir, ".pi", "agent", "tmp", "pigram");
  const statePath = join(tempDir, "state.json");
  return { scope: "global", configPath, statePath, tempDir };
}

export async function resolveScope(opts: {
  cwd: string;
  homeDir: string;
  scope?: Scope;
}): Promise<ResolvedPaths> {
  const projectPaths = getProjectPaths(opts.cwd);
  const globalPaths = getGlobalPaths(opts.homeDir);

  // If scope is forced, return that scope's paths
  if (opts.scope === "project") return projectPaths;
  if (opts.scope === "global") return globalPaths;

  // Check if project config exists
  if (await pathExists(projectPaths.configPath)) return projectPaths;

  // Check if global config exists
  if (await pathExists(globalPaths.configPath)) return globalPaths;

  // Default to project
  return projectPaths;
}

export async function readConfig(
  paths: ResolvedPaths
): Promise<PigramConfig | null> {
  if (!(await pathExists(paths.configPath))) {
    return null;
  }

  const content = await readFile(paths.configPath, "utf8");
  
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Failed to parse config at ${paths.configPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const result = validateConfig(parsed);
  if (!result.ok) {
    throw new Error(
      `Invalid config at ${paths.configPath}: ${result.errors.join(", ")}`
    );
  }

  return result.config;
}

export async function writeConfig(
  paths: ResolvedPaths,
  config: PigramConfig
): Promise<void> {
  const dir = join(paths.configPath, "..");
  await mkdir(dir, { recursive: true });
  await writeFile(paths.configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export async function readState(
  paths: ResolvedPaths
): Promise<PigramState> {
  if (!(await pathExists(paths.statePath))) {
    return { lastUpdateId: 0 };
  }

  const content = await readFile(paths.statePath, "utf8");
  const state = JSON.parse(content) as PigramState;
  return state;
}

export async function writeState(
  paths: ResolvedPaths,
  state: PigramState
): Promise<void> {
  await mkdir(paths.tempDir, { recursive: true });
  await writeFile(paths.statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

const PIGRAM_GITIGNORE_COMMENT = "# pigram local secrets/cache";
const PIGRAM_GITIGNORE_CONFIG_ENTRY = ".pi/pigram.json";
const PIGRAM_GITIGNORE_TEMP_ENTRY = ".pi/tmp/";
const PIGRAM_GITIGNORE_BLOCK = `${PIGRAM_GITIGNORE_COMMENT}\n${PIGRAM_GITIGNORE_CONFIG_ENTRY}\n${PIGRAM_GITIGNORE_TEMP_ENTRY}\n`;

export async function ensureProjectGitignore(cwd: string): Promise<void> {
  await mkdir(cwd, { recursive: true });
  const gitignorePath = join(cwd, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(gitignorePath, "utf8");
  } catch {
    // ignore missing file
  }

  const hasConfigEntry = existing.includes(`${PIGRAM_GITIGNORE_CONFIG_ENTRY}\n`) || existing.endsWith(PIGRAM_GITIGNORE_CONFIG_ENTRY);
  const hasTempEntry = existing.includes(`${PIGRAM_GITIGNORE_TEMP_ENTRY}\n`) || existing.endsWith(PIGRAM_GITIGNORE_TEMP_ENTRY);

  if (hasConfigEntry && hasTempEntry) return;

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n` : existing;
  await writeFile(gitignorePath, prefix + PIGRAM_GITIGNORE_BLOCK, "utf8");
}
