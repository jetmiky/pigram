import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tryAcquireLock,
  releaseLock,
  isPidAlive,
  type LockInfo,
} from "../src/config/lock.js";

describe("Lock", () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pigram-lock-test-"));
    lockPath = join(tempDir, "lock.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("isPidAlive", () => {
    test("own PID is alive", () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    test("non-existent PID returns false", () => {
      expect(isPidAlive(999999)).toBe(false);
    });
  });

  describe("tryAcquireLock", () => {
    test("acquires lock on fresh path", async () => {
      const result = await tryAcquireLock(lockPath, "tokenhash123");

      expect(result.acquired).toBe(true);

      const content = JSON.parse(await readFile(lockPath, "utf8"));
      expect(content.pid).toBe(process.pid);
      expect(content.tokenHash).toBe("tokenhash123");
      expect(content.startedAt).toBeDefined();
      expect(content.heartbeat).toBeDefined();
    });

    test("re-enters when same PID holds the lock", async () => {
      await tryAcquireLock(lockPath, "tokenhash123");
      const result = await tryAcquireLock(lockPath, "tokenhash123");
      expect(result.acquired).toBe(true);
    });

    test("steals lock when holder PID is dead", async () => {
      const staleLock: LockInfo = {
        pid: 999999,
        tokenHash: "tokenhash123",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        heartbeat: new Date(Date.now() - 60_000).toISOString(),
      };

      await writeFile(lockPath, JSON.stringify(staleLock));

      const result = await tryAcquireLock(lockPath, "tokenhash123");

      expect(result.acquired).toBe(true);
      const content = JSON.parse(await readFile(lockPath, "utf8"));
      expect(content.pid).toBe(process.pid);
    });

    test("refuses when another live process holds the same bot", async () => {
      // Write a helper script that acquires the lock and signals readiness.
      const signalFile = join(tempDir, "ready.signal");

      const helperScript = `
        import { tryAcquireLock } from ${JSON.stringify(join(process.cwd(), "src/config/lock.js"))};
        const result = await tryAcquireLock(${JSON.stringify(lockPath)}, "tokenhash123");
        if (result.acquired) {
          // Signal readiness with our PID
          await import("node:fs/promises").then(fs =>
            fs.writeFile(${JSON.stringify(signalFile)}, String(process.pid))
          );
          // Hold the lock until killed
          await new Promise(() => {});
        } else {
          process.exit(1);
        }
      `;

      const scriptFile = join(tempDir, "helper.ts");
      await writeFile(scriptFile, helperScript);

      const child = Bun.spawn(["bun", "run", scriptFile], {
        stdout: "ignore",
        stderr: "ignore",
      });

      // Wait for child to signal readiness (max 5s)
      const childPid = await waitForFile(signalFile, 5000).then(Number);
      expect(childPid).toBeGreaterThan(0);

      // Now try to acquire from this process — should be refused
      const result = await tryAcquireLock(lockPath, "tokenhash123");
      expect(result.acquired).toBe(false);

      if (!result.acquired) {
        expect(result.holderPid).toBe(childPid);
        expect(result.holderSince).toBeDefined();
      }

      // Cleanup
      child.kill("SIGTERM");
      await child.exited;
    });

    test("acquires when live PID holds different token (different bot)", async () => {
      const otherLock: LockInfo = {
        pid: process.pid,
        tokenHash: "other-token-hash",
        startedAt: new Date(Date.now() - 10_000).toISOString(),
        heartbeat: new Date().toISOString(),
      };

      await writeFile(lockPath, JSON.stringify(otherLock));

      const result = await tryAcquireLock(lockPath, "my-token-hash");
      // Same PID → re-entry → acquired
      expect(result.acquired).toBe(true);
    });

    test("concurrent acquisition: only one wins (wx atomic write)", async () => {
      // The core guarantee comes from writeFile with { flag: "wx" }.
      // Two concurrent wx writes to the same path — exactly one succeeds,
      // the other gets EEXIST. This is an OS-level atomic operation.
      // We test this directly rather than through child processes, since
      // Bun spawns so fast that sequential child processes don't actually race.
      const now = new Date().toISOString();

      const payload = JSON.stringify({
        pid: process.pid,
        tokenHash: "tokenhash123",
        startedAt: now,
        heartbeat: now,
      });

      const results = await Promise.allSettled([
        writeFile(lockPath, payload, { flag: "wx" }),
        writeFile(lockPath, payload, { flag: "wx" }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Exactly one should succeed, one should fail with EEXIST
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const rejectErr = (rejected[0] as PromiseRejectedResult).reason as NodeJS.ErrnoException;
      expect(rejectErr.code).toBe("EEXIST");

      // The lock file should contain valid JSON
      const content = JSON.parse(await readFile(lockPath, "utf8"));
      expect(content.pid).toBe(process.pid);
    });
  });

  describe("releaseLock", () => {
    test("deletes the lock file", async () => {
      await tryAcquireLock(lockPath, "tokenhash123");

      const before = await readFile(lockPath, "utf8");
      expect(before).toBeTruthy();

      await releaseLock(lockPath);

      let exists = true;

      try {
        await access(lockPath);
      } catch {
        exists = false;
      }

      expect(exists).toBe(false);
    });

    test("is a no-op when lock file doesn't exist", async () => {
      await releaseLock(lockPath);
    });
  });
});

/** Wait for a file to appear, then return its content. Rejects after timeout. */
async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  throw new Error(`Timed out waiting for ${path}`);
}
