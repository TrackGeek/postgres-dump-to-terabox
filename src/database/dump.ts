import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface DumpResult {
  path: string;
  fileName: string;
  size: number;
  durationMs: number;
}

/** `trackgeek-20260805-031500.dump` — the timestamp is what retention reads back. */
export function buildDumpFileName(prefix: string, date = new Date()): string {
  const iso = date.toISOString();
  const day = iso.slice(0, 10).replace(/-/g, "");
  const time = iso.slice(11, 19).replace(/:/g, "");

  return `${prefix}-${day}-${time}.dump`;
}

export function parseDumpDate(fileName: string, prefix: string): Date | null {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escapedPrefix}-(\\d{8})-(\\d{6})\\.dump$`).exec(fileName);
  const day = match?.[1];
  const time = match?.[2];

  if (!day || !time) {
    return null;
  }

  const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`;
  const parsed = new Date(iso);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * pg_dump refuses to talk to a newer server, and the raw message does not say how to
 * fix it — spell the fix out, because this breaks again on every server major upgrade.
 */
function versionHint(stderr: string): string {
  const match = /server version: (\d+)[^\n]*?pg_dump version: (\d+)/s.exec(stderr);

  if (!match) {
    return "";
  }

  const [, serverMajor, clientMajor] = match;

  return `\n\nThe client tools are older than the server (pg_dump ${clientMajor} vs server ${serverMajor}). Install PostgreSQL ${serverMajor} client tools and point PG_DUMP_BIN at them, e.g. PG_DUMP_BIN='/opt/homebrew/opt/libpq/bin/pg_dump'.`;
}

/**
 * Custom format is already zlib-compressed and restores with `pg_restore`, so no
 * external gzip step is needed. The connection URL only ever reaches argv, never the logs.
 */
export async function createDump(
  databaseUrl: string,
  tmpDir: string,
  prefix: string,
  binary = "pg_dump",
): Promise<DumpResult> {
  const startedAt = Date.now();

  await mkdir(tmpDir, { recursive: true });

  const fileName = buildDumpFileName(prefix);
  const filePath = join(tmpDir, fileName);

  const args = [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    "--compress=6",
    "--file",
    filePath,
    "--dbname",
    databaseUrl,
  ];

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        reject(
          error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
            ? new Error(`${binary} not found. Install the PostgreSQL client tools or set PG_DUMP_BIN.`)
            : error,
        );
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        const tail = stderr.trim().split("\n").slice(-5).join("\n");

        reject(new Error(`${binary} exited with code ${code}${tail ? `:\n${tail}` : ""}${versionHint(stderr)}`));
      });
    });

    const stats = await stat(filePath);

    if (stats.size === 0) {
      throw new Error("pg_dump produced an empty file");
    }

    return { path: filePath, fileName, size: stats.size, durationMs: Date.now() - startedAt };
  } catch (error) {
    // pg_dump leaves a truncated file behind when it aborts; do not let it pile up in tmp.
    await rm(filePath, { force: true });

    throw error;
  }
}
