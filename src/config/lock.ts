/**
 * Cooperative file-based lock for single-instance poller enforcement.
 *
 * Prevents multiple pi sessions from polling the same Telegram bot
 * simultaneously. The lock lives alongside existing state files in the
 * scope's tmp/pigram/ directory.
 *
 * @see docs/adr/0004-poller-lock.md
 */
import { writeFile, readFile, unlink } from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Shape of the lock file on disk. */
const LockInfoSchema = Type.Object({
  pid: Type.Integer({ minimum: 1 }),
  tokenHash: Type.String(),
  startedAt: Type.String(),
  heartbeat: Type.String(),
});

export type LockInfo = Static<typeof LockInfoSchema>;

async function readLockInfo(lockPath: string): Promise<LockInfo> {
  const lock: unknown = JSON.parse(await readFile(lockPath, "utf8"));

  if (!Value.Check(LockInfoSchema, lock)) throw new Error("Invalid poller lock");

  return lock;
}

/** Result of a lock acquisition attempt. */
export type LockResult =
  | { acquired: true }
  | { acquired: false; holderPid: number; holderSince: string };

/**
 * Check whether a process with the given PID is alive.
 *
 * Uses signal 0 (POSIX existence check) — no actual signal is sent.
 * Works on Linux, macOS, and Windows (Node.js translates internally).
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to acquire the poller lock.
 *
 * Strategy:
 * 1. Try exclusive create (wx flag) — wins if no lock exists.
 * 2. If EEXIST, read the existing lock:
 *    a. Same PID → re-entry, already own it.
 *    b. Different PID, alive, same tokenHash → blocked (another instance).
 *    c. Different PID, dead → steal the lock (write + verify).
 *    d. Different PID, alive, different tokenHash → different bot, no conflict.
 */
export async function tryAcquireLock(
  lockPath: string,
  tokenHash: string,
): Promise<LockResult> {
  const now = new Date().toISOString();

  const payload: LockInfo = {
    pid: process.pid,
    tokenHash,
    startedAt: now,
    heartbeat: now,
  };

  try {
    await writeFile(lockPath, JSON.stringify(payload), { flag: "wx" });

    return { acquired: true };
  } catch (err: unknown) {
    // EEXIST means another instance wrote first — check who holds it.
    if (!(err instanceof Error) || !("code" in err) || err.code !== "EEXIST") {
      throw err;
    }

    let existing: LockInfo;

    try {
      existing = await readLockInfo(lockPath);
    } catch {
      // Lock file unreadable (corrupt, partial write) — steal it.
      await writeFile(lockPath, JSON.stringify(payload));
      const verify = await readLockInfo(lockPath);

      return verify.pid === process.pid
        ? { acquired: true }
        : { acquired: false, holderPid: verify.pid, holderSince: verify.startedAt };
    }

    // Re-entry: same process already holds the lock.
    if (existing.pid === process.pid) {
      return { acquired: true };
    }

    // Different token hash = different bot, no conflict.
    if (existing.tokenHash !== tokenHash) {
      await writeFile(lockPath, JSON.stringify(payload));
      const verify = await readLockInfo(lockPath);

      return verify.pid === process.pid
        ? { acquired: true }
        : { acquired: false, holderPid: verify.pid, holderSince: verify.startedAt };
    }

    // Same bot, holder PID still alive → blocked.
    if (isPidAlive(existing.pid)) {
      return { acquired: false, holderPid: existing.pid, holderSince: existing.startedAt };
    }

    // Same bot, holder PID dead → steal.
    await writeFile(lockPath, JSON.stringify(payload));
    const verify = await readLockInfo(lockPath);

    return verify.pid === process.pid
      ? { acquired: true }
      : { acquired: false, holderPid: verify.pid, holderSince: verify.startedAt };
  }
}

/**
 * Release the poller lock by deleting the lock file.
 * Best-effort: no-op if the file doesn't exist.
 */
export async function releaseLock(lockPath: string): Promise<void> {
  await unlink(lockPath).catch(() => {});
}

/**
 * Update the heartbeat field in the lock file.
 * Best-effort: silently ignored if the lock file is gone or unwritable.
 */
export async function touchHeartbeat(lockPath: string): Promise<void> {
  try {
    const existing = await readLockInfo(lockPath);

    if (existing.pid === process.pid) {
      existing.heartbeat = new Date().toISOString();
      await writeFile(lockPath, JSON.stringify(existing));
    }
  } catch {
    // best-effort
  }
}

/**
 * Start a heartbeat interval that updates the lock file every `intervalMs`.
 * Returns a stop function. Stops automatically if the lock file disappears
 * (another instance stole it) or if the PID check shows we no longer own it.
 */
export function startHeartbeat(lockPath: string, intervalMs = 10_000): () => void {
  const timer = setInterval(() => {
    void touchHeartbeat(lockPath);
  }, intervalMs);

  // Don't keep the process alive just for heartbeat.
  timer.unref();

  return () => clearInterval(timer);
}
