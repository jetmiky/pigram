import { join } from "node:path";
import { access, readFile } from "node:fs/promises";
import type { PigramConfig } from "./schema.js";
import type { PigramState, ResolvedPaths, Scope } from "./store.js";
import { writeConfig, writeState, resolveScope } from "./store.js";

export type MigrationResult =
  | { status: "migrated"; configPath: string; statePath: string }
  | { status: "skipped-existing" }
  | { status: "no-legacy" }
  | { status: "error"; message: string };

interface LegacyConfig {
  botToken?: string;
  botUsername?: string;
  botId?: number;
  allowedUserId?: number;
  lastUpdateId?: number;
  streamPreviews?: boolean;
  richText?: boolean;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function getLegacyPath(opts: {
  cwd: string;
  homeDir: string;
  scope: Scope;
}): string {
  if (opts.scope === "project") {
    return join(opts.cwd, ".pi", "telegram.json");
  } else {
    return join(opts.homeDir, ".pi", "agent", "telegram.json");
  }
}

export function legacyPaths(opts: {
  cwd: string;
  homeDir: string;
  scope: Scope;
}): { legacyConfigPath: string } {
  return {
    legacyConfigPath: getLegacyPath(opts),
  };
}

export async function migrateLegacyConfig(opts: {
  cwd: string;
  homeDir: string;
  scope: "project" | "global";
}): Promise<MigrationResult> {
  // Resolve target paths for the new config and state
  const paths: ResolvedPaths = await resolveScope({
    cwd: opts.cwd,
    homeDir: opts.homeDir,
    scope: opts.scope,
  });

  // Check if new pigram.json already exists - if so, skip migration
  if (await pathExists(paths.configPath)) {
    return { status: "skipped-existing" };
  }

  // Get legacy path
  const legacyPath = getLegacyPath(opts);

  // Check if legacy file exists
  if (!(await pathExists(legacyPath))) {
    return { status: "no-legacy" };
  }

  // Read and parse legacy file
  let legacyContent: string;
  try {
    legacyContent = await readFile(legacyPath, "utf8");
  } catch (err) {
    return {
      status: "error",
      message: `Failed to read legacy config: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let legacy: LegacyConfig;
  try {
    legacy = JSON.parse(legacyContent) as LegacyConfig;
  } catch (err) {
    return {
      status: "error",
      message: `Failed to parse legacy config: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Validate botToken is present
  if (!legacy.botToken || legacy.botToken.trim().length === 0) {
    return {
      status: "error",
      message: "Legacy config missing required botToken field",
    };
  }

  // Map to new Config
  const newConfig: PigramConfig = {
    botToken: legacy.botToken,
    ux: {
      richText: legacy.richText ?? true,
      streamPreviews: legacy.streamPreviews ?? true,
    },
  };

  // Map to new State
  const newState: PigramState = {
    lastUpdateId: legacy.lastUpdateId ?? 0,
  };

  // Add optional state fields only if present in legacy
  if (legacy.allowedUserId !== undefined) {
    newState.pairedUserId = legacy.allowedUserId;
  }
  if (legacy.botId !== undefined) {
    newState.botId = legacy.botId;
  }
  if (legacy.botUsername !== undefined) {
    newState.botUsername = legacy.botUsername;
  }

  // Write new config and state
  try {
    await writeConfig(paths, newConfig);
    await writeState(paths, newState);
  } catch (err) {
    return {
      status: "error",
      message: `Failed to write new config/state: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    status: "migrated",
    configPath: paths.configPath,
    statePath: paths.statePath,
  };
}
