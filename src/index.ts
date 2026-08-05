import { join } from "node:path";
import cron from "node-cron";
import { config } from "./config";
import { acquireLock } from "./lock";
import { logger } from "./logger";
import { runBackup } from "./pipeline";

const LOCK_PATH = join(config.backup.tmpDir, "backup.lock");

let running: Promise<void> | null = null;
let shuttingDown = false;

async function runGuarded(trigger: string): Promise<boolean> {
  if (running) {
    logger.warn("Skipping run: another backup is still in progress", { trigger });
    return false;
  }

  const release = acquireLock(LOCK_PATH);

  if (!release) {
    logger.warn("Skipping run: lock held by another process", { trigger, lockPath: LOCK_PATH });
    return false;
  }

  logger.info("Backup run started", { trigger });

  running = runBackup();

  try {
    await running;
    return true;
  } catch {
    // runBackup already logged and notified; the caller decides the exit code.
    return false;
  } finally {
    running = null;
    release();
  }
}

async function main() {
  if (process.argv.includes("--once")) {
    const ok = await runGuarded("manual");
    process.exit(ok ? 0 : 1);
  }

  if (!cron.validate(config.scheduler.cronSchedule)) {
    throw new Error(`Invalid CRON_SCHEDULE: "${config.scheduler.cronSchedule}"`);
  }

  const task = cron.schedule(config.scheduler.cronSchedule, () => void runGuarded("cron"), {
    timezone: config.scheduler.timezone,
  });

  logger.info("Scheduler started", {
    schedule: config.scheduler.cronSchedule,
    timezone: config.scheduler.timezone,
    database: config.databaseLabel,
    remoteDir: config.terabox.remoteDir,
    retentionDays: config.backup.retentionDays,
    dryRun: config.backup.dryRun,
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      logger.info("Shutting down, waiting for the current run to finish", { signal });

      void task.stop();
      void Promise.resolve(running).finally(() => process.exit(0));
    });
  }

  if (config.scheduler.runOnBoot) {
    await runGuarded("boot");
  }
}

main().catch((error: unknown) => {
  logger.error("Fatal error", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
