import { rm } from "node:fs/promises";
import { config } from "./config";
import { createDump, parseDumpDate } from "./database/dump";
import { formatBytes, formatDuration, logger } from "./logger";
import { DiscordNotifier, type Stage } from "./notify/discord";
import { getCredentials } from "./terabox/auth";
import { deleteRemoteFiles, ensureRemoteDir, listRemoteFiles, privateFolderUrl, uploadChunked } from "./terabox/client";
import { NetworkError, SessionExpiredError } from "./terabox/constants";

const notifier = new DiscordNotifier(config.discordWebhookUrl);

interface ExpiredCandidate {
  path: string;
  name: string;
  ageDays: number;
}

/**
 * The timestamp baked into the file name is authoritative; `server_mtime` is only a
 * fallback, and anything we cannot date is left alone rather than guessed at.
 */
export function selectExpired(
  files: Array<{ path: string; server_filename: string; server_mtime: number; isdir: number }>,
  prefix: string,
  retentionDays: number,
): { expired: ExpiredCandidate[]; keptCount: number } {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const expired: ExpiredCandidate[] = [];
  let keptCount = 0;

  for (const file of files) {
    if (file.isdir !== 0) {
      continue;
    }

    const fromName = parseDumpDate(file.server_filename, prefix);
    const createdAt = fromName ?? (file.server_mtime ? new Date(file.server_mtime * 1000) : null);

    if (!fromName && !file.server_filename.startsWith(`${prefix}-`)) {
      // Not ours — never touch it.
      continue;
    }

    if (!createdAt || createdAt.getTime() >= cutoff) {
      keptCount += 1;
      continue;
    }

    expired.push({
      path: file.path,
      name: file.server_filename,
      ageDays: Math.floor((Date.now() - createdAt.getTime()) / (24 * 60 * 60 * 1000)),
    });
  }

  return { expired, keptCount };
}

export async function runBackup(): Promise<void> {
  const startedAt = Date.now();
  let stage: Stage = "started";
  let localDumpPath: string | null = null;

  try {
    await notifier.notify("started", [
      { name: "Banco", value: config.databaseLabel },
      { name: "Destino", value: config.terabox.remoteDir },
      { name: "Retenção", value: `${config.backup.retentionDays} dias` },
      { name: "Dry run", value: config.backup.dryRun ? "sim" : "não" },
    ]);

    stage = "auth";
    const credentials = await getCredentials(config.terabox.storageStatePath);

    await notifier.notify("auth", [
      { name: "jsToken", value: `${credentials.jsToken.slice(0, 8)}… (${credentials.jsToken.length} chars)` },
    ]);

    stage = "dumped";
    const dump = await createDump(
      config.databaseUrl,
      config.backup.tmpDir,
      config.backup.prefix,
      config.backup.pgDumpBin,
    );
    localDumpPath = dump.path;

    await notifier.notify("dumped", [
      { name: "Arquivo", value: dump.fileName },
      { name: "Tamanho", value: formatBytes(dump.size) },
      { name: "Duração", value: formatDuration(dump.durationMs) },
    ]);

    stage = "uploaded";
    await ensureRemoteDir(config.terabox.remoteDir, credentials, config.terabox.appId);
    const upload = await uploadChunked(dump.path, config.terabox.remoteDir, credentials, config.terabox.appId);

    const folderUrl = privateFolderUrl(config.terabox.remoteDir);

    await notifier.notify(
      "uploaded",
      [
        { name: "Caminho remoto", value: upload.remotePath },
        { name: "Tamanho", value: formatBytes(upload.size) },
        { name: "Chunks", value: `${upload.uploadedChunks}/${upload.chunks}` },
        { name: "Rapid upload", value: upload.rapidUpload ? "sim" : "não" },
        { name: "Duração", value: formatDuration(upload.durationMs) },
      ],
      `[Abrir \`${dump.fileName}\` no Terabox](${folderUrl})`,
    );

    stage = "cleaned";
    await applyRetention(credentials, dump.fileName);

    stage = "finished";
    await notifier.notify(
      "finished",
      [
        { name: "Arquivo", value: dump.fileName },
        { name: "Tamanho", value: formatBytes(dump.size) },
        { name: "Duração total", value: formatDuration(Date.now() - startedAt) },
      ],
      `[Abrir \`${dump.fileName}\` no Terabox](${folderUrl})`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error && error.stack ? error.stack.split("\n").slice(1, 5).join("\n") : "";
    const action =
      error instanceof SessionExpiredError
        ? "Rodar `bun run login` no servidor"
        : error instanceof NetworkError
          ? "Sem DNS/rede no container — checar `dns:` no docker-compose e VPN do host"
          : null;

    logger.error("Backup failed", { stage, error: message });

    await notifier.notify(
      "failed",
      [
        { name: "Estágio", value: stage },
        { name: "Banco", value: config.databaseLabel },
        { name: "Duração até falhar", value: formatDuration(Date.now() - startedAt) },
        ...(action ? [{ name: "Ação", value: action, inline: false }] : []),
      ],
      `**${message}**${stack ? `\n\`\`\`\n${stack}\n\`\`\`` : ""}`,
    );

    throw error;
  } finally {
    if (localDumpPath) {
      await rm(localDumpPath, { force: true }).catch((error: unknown) =>
        logger.warn("Could not remove the local dump", {
          path: localDumpPath,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

async function applyRetention(
  credentials: Awaited<ReturnType<typeof getCredentials>>,
  justUploadedName: string,
): Promise<void> {
  const files = await listRemoteFiles(config.terabox.remoteDir, credentials, config.terabox.appId);

  // If the listing does not contain the file we just uploaded, the view is not
  // trustworthy — deleting from it risks wiping good backups. Bail out instead.
  if (!files.some((file) => file.server_filename === justUploadedName)) {
    await notifier.notify(
      "cleaned",
      [
        { name: "Status", value: "abortada" },
        { name: "Motivo", value: "backup recém-enviado não apareceu na listagem", inline: false },
        { name: "Arquivos listados", value: String(files.length) },
      ],
      "Nenhum arquivo foi apagado.",
    );

    return;
  }

  const { expired, keptCount } = selectExpired(files, config.backup.prefix, config.backup.retentionDays);

  if (expired.length === 0) {
    await notifier.notify("cleaned", [
      { name: "Apagados", value: "0" },
      { name: "Mantidos", value: String(keptCount) },
      { name: "Retenção", value: `${config.backup.retentionDays} dias` },
    ]);

    return;
  }

  // A cleanup that would leave zero backups behind is a bug, not a retention rule.
  if (keptCount === 0) {
    await notifier.notify(
      "cleaned",
      [
        { name: "Status", value: "abortada" },
        { name: "Motivo", value: "a limpeza deixaria zero backups", inline: false },
        { name: "Candidatos", value: String(expired.length) },
      ],
      "Nenhum arquivo foi apagado.",
    );

    return;
  }

  if (config.backup.dryRun) {
    await notifier.notify(
      "cleaned",
      [
        { name: "Status", value: "dry run" },
        { name: "Seriam apagados", value: String(expired.length) },
        { name: "Mantidos", value: String(keptCount) },
      ],
      expired.map((file) => `• ${file.name} (${file.ageDays}d)`).join("\n"),
    );

    return;
  }

  await deleteRemoteFiles(
    expired.map((file) => file.path),
    credentials,
    config.terabox.appId,
  );

  await notifier.notify(
    "cleaned",
    [
      { name: "Apagados", value: String(expired.length) },
      { name: "Mantidos", value: String(keptCount) },
      { name: "Retenção", value: `${config.backup.retentionDays} dias` },
    ],
    expired.map((file) => `• ${file.name} (${file.ageDays}d)`).join("\n"),
  );
}
