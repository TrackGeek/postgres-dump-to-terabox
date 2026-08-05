import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "./logger";

const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Best-effort mutual exclusion so a slow run never overlaps the next cron tick.
 * Returns a release function, or null when another run already holds the lock.
 */
export function acquireLock(lockPath: string): (() => void) | null {
  mkdirSync(dirname(lockPath), { recursive: true });

  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }

    const age = Date.now() - statSync(lockPath).mtimeMs;
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    const orphaned = age > STALE_AFTER_MS || !Number.isInteger(pid) || !isProcessAlive(pid);

    if (!orphaned) {
      return null;
    }

    logger.warn("Removing stale lock file", { lockPath, pid, ageMs: Math.round(age) });
    rmSync(lockPath, { force: true });
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  }

  return () => rmSync(lockPath, { force: true });
}
