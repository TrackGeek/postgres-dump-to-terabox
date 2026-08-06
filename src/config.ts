import { resolve } from "node:path";

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function required(key: string): string {
  const value = process.env[key]?.trim();

  if (!value) {
    throw new ConfigError(`Missing required env var: ${key}`);
  }

  return value;
}

function optional(key: string, fallback: string): string {
  const value = process.env[key]?.trim();

  return value ? value : fallback;
}

function integer(key: string, fallback: number): number {
  const value = process.env[key]?.trim();

  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`Invalid env var ${key}: expected a positive integer, got "${value}"`);
  }

  return parsed;
}

function boolean(key: string, fallback: boolean): boolean {
  const value = process.env[key]?.trim().toLowerCase();

  if (!value) {
    return fallback;
  }

  if (value !== "true" && value !== "false") {
    throw new ConfigError(`Invalid env var ${key}: expected "true" or "false", got "${value}"`);
  }

  return value === "true";
}

function normalizeRemoteDir(value: string): string {
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;

  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, "") : withLeadingSlash;
}

/**
 * The database name is safe to log; the full URL is not (it carries the password).
 */
function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url);

    return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
  } catch {
    throw new ConfigError("Invalid env var DATABASE_URL: not a valid connection URL");
  }
}

const databaseUrl = required("DATABASE_URL");

export const config = {
  databaseUrl,
  databaseLabel: describeDatabase(databaseUrl),
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL?.trim() || "",
  terabox: {
    appId: optional("TERABOX_APP_ID", "250528"),
    remoteDir: normalizeRemoteDir(optional("TERABOX_REMOTE_DIR", "/trackgeek-backups")),
    storageStatePath: resolve(optional("TERABOX_STORAGE_STATE", "./secrets/storageState.json")),
  },
  backup: {
    pgDumpBin: optional("PG_DUMP_BIN", "pg_dump"),
    prefix: optional("BACKUP_PREFIX", "trackgeek"),
    retentionDays: integer("RETENTION_DAYS", 7),
    tmpDir: resolve(optional("TMP_DIR", "./tmp")),
    dryRun: boolean("DRY_RUN", false),
  },
  scheduler: {
    cronSchedule: optional("CRON_SCHEDULE", "0 */12 * * *"),
    runOnBoot: boolean("RUN_ON_BOOT", true),
    timezone: optional("TZ", "America/Sao_Paulo"),
  },
} as const;

export type Config = typeof config;
