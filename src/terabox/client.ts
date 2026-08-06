import { createHash, randomBytes } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import TeraboxUploader, { type TeraboxFileEntry } from "terabox-upload-tool";
import { logger } from "../logger";
import type { TeraboxCredentials } from "./auth";
import { cookieHeader, TERABOX_ORIGIN, TERABOX_UPLOAD_ORIGIN, USER_AGENT } from "./constants";

/** Terabox splits uploads into 4 MiB blocks; every block but the last must be exactly this size. */
const CHUNK_SIZE = 4 * 1024 * 1024;
const CHUNK_RETRIES = 3;

export interface UploadResult {
  remotePath: string;
  size: number;
  chunks: number;
  uploadedChunks: number;
  rapidUpload: boolean;
  durationMs: number;
}

export class TeraboxApiError extends Error {
  readonly errno: number;

  constructor(step: string, errno: number, errmsg?: string) {
    super(`Terabox ${step} failed (errno ${errno}${errmsg ? `: ${errmsg}` : ""})`);
    this.name = "TeraboxApiError";
    this.errno = errno;
  }
}

interface ApiEnvelope {
  errno?: number;
  errmsg?: string;
  [key: string]: unknown;
}

function newDpLogId(): string {
  return randomBytes(10).toString("hex").toUpperCase();
}

function apiUrl(path: string, credentials: TeraboxCredentials, dpLogId: string, appId: string): string {
  const query = new URLSearchParams({
    app_id: appId,
    web: "1",
    channel: "dubox",
    clienttype: "0",
    jsToken: credentials.jsToken,
    "dp-logid": dpLogId,
  });

  return `${TERABOX_ORIGIN}${path}?${query.toString()}`;
}

async function postForm(url: string, body: URLSearchParams, ndus: string, step: string): Promise<ApiEnvelope> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(ndus),
      "User-Agent": USER_AGENT,
      Referer: `${TERABOX_ORIGIN}/main`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Terabox ${step} responded with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as ApiEnvelope;

  if (typeof payload.errno === "number" && payload.errno !== 0) {
    throw new TeraboxApiError(step, payload.errno, payload.errmsg);
  }

  return payload;
}

async function readChunk(filePath: string, index: number, size: number): Promise<Buffer> {
  const handle = await open(filePath, "r");

  try {
    const length = Math.min(CHUNK_SIZE, size - index * CHUNK_SIZE);
    const buffer = Buffer.allocUnsafe(length);

    await handle.read(buffer, 0, length, index * CHUNK_SIZE);

    return buffer;
  } finally {
    await handle.close();
  }
}

/**
 * Streams the file once to build the per-chunk MD5 list precreate expects,
 * so a multi-gigabyte dump never lands in memory whole.
 */
export async function buildBlockList(filePath: string, size: number, chunkCount: number): Promise<string[]> {
  const handle = await open(filePath, "r");
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
  const blockList: string[] = [];

  try {
    for (let index = 0; index < chunkCount; index += 1) {
      const length = Math.min(CHUNK_SIZE, size - index * CHUNK_SIZE);
      const { bytesRead } = await handle.read(buffer, 0, length, index * CHUNK_SIZE);

      blockList.push(createHash("md5").update(buffer.subarray(0, bytesRead)).digest("hex"));
    }
  } finally {
    await handle.close();
  }

  return blockList;
}

async function uploadChunk(
  filePath: string,
  remotePath: string,
  index: number,
  size: number,
  uploadId: string,
  credentials: TeraboxCredentials,
  appId: string,
): Promise<void> {
  const query = new URLSearchParams({
    method: "upload",
    app_id: appId,
    channel: "dubox",
    clienttype: "0",
    web: "1",
    path: remotePath,
    uploadid: uploadId,
    uploadsign: "0",
    partseq: String(index),
  });
  const url = `${TERABOX_UPLOAD_ORIGIN}/rest/2.0/pcs/superfile2?${query.toString()}`;

  let lastError: unknown;

  for (let attempt = 1; attempt <= CHUNK_RETRIES; attempt += 1) {
    try {
      const chunk = await readChunk(filePath, index, size);
      const form = new FormData();

      form.append("file", new Blob([chunk]), basename(remotePath));

      const response = await fetch(url, {
        method: "POST",
        headers: { Cookie: cookieHeader(credentials.ndus), "User-Agent": USER_AGENT },
        body: form,
      });

      if (!response.ok) {
        throw new Error(`chunk ${index} responded with HTTP ${response.status}`);
      }

      const payload = (await response.json()) as ApiEnvelope & { md5?: string };

      if (typeof payload.errno === "number" && payload.errno !== 0) {
        throw new TeraboxApiError(`chunk ${index} upload`, payload.errno, payload.errmsg);
      }

      return;
    } catch (error) {
      lastError = error;

      if (attempt < CHUNK_RETRIES) {
        const backoff = 2 ** attempt * 1000;

        logger.warn("Chunk upload failed, retrying", {
          index,
          attempt,
          backoffMs: backoff,
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function uploadChunked(
  filePath: string,
  remoteDir: string,
  credentials: TeraboxCredentials,
  appId: string,
): Promise<UploadResult> {
  const startedAt = Date.now();
  const stats = await stat(filePath);
  const size = stats.size;

  if (size === 0) {
    throw new Error(`Refusing to upload an empty file: ${filePath}`);
  }

  const remotePath = `${remoteDir}/${basename(filePath)}`;
  const chunkCount = Math.max(1, Math.ceil(size / CHUNK_SIZE));
  const blockList = await buildBlockList(filePath, size, chunkCount);
  const dpLogId = newDpLogId();
  const localMtime = Math.floor(stats.mtimeMs / 1000);

  const precreate = await postForm(
    apiUrl("/api/precreate", credentials, dpLogId, appId),
    new URLSearchParams({
      path: remotePath,
      autoinit: "1",
      target_path: remoteDir,
      block_list: JSON.stringify(blockList),
      size: String(size),
      local_mtime: String(localMtime),
    }),
    credentials.ndus,
    "precreate",
  );

  const uploadId = precreate.uploadid;

  if (typeof uploadId !== "string" || uploadId.length === 0) {
    throw new Error("Terabox precreate returned no uploadid");
  }

  // precreate echoes back the indices that still need bytes; an empty list means
  // the server already had every block (rapid upload).
  const pending = Array.isArray(precreate.block_list)
    ? (precreate.block_list as number[])
    : Array.from({ length: chunkCount }, (_, index) => index);

  for (const index of pending) {
    await uploadChunk(filePath, remotePath, index, size, uploadId, credentials, appId);
    logger.info("Chunk uploaded", { index: index + 1, of: chunkCount });
  }

  await postForm(
    apiUrl("/api/create", credentials, dpLogId, appId),
    new URLSearchParams({
      path: remotePath,
      size: String(size),
      uploadid: uploadId,
      target_path: remoteDir,
      block_list: JSON.stringify(blockList),
      local_mtime: String(localMtime),
      isdir: "0",
      rtype: "1",
    }),
    credentials.ndus,
    "create",
  );

  return {
    remotePath,
    size,
    chunks: chunkCount,
    uploadedChunks: pending.length,
    rapidUpload: pending.length === 0,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Deep link into the account's own file manager. It only resolves for whoever is
 * logged into the account, so pasting it in Discord exposes nothing on its own.
 * No share link is ever created — `/share/pset` would publish the dump publicly.
 */
export function privateFolderUrl(remoteDir: string): string {
  return `${TERABOX_ORIGIN}/main?category=all&path=${encodeURIComponent(remoteDir)}`;
}

function uploader(credentials: TeraboxCredentials, appId: string): TeraboxUploader {
  return new TeraboxUploader({ ndus: credentials.ndus, appId, jsToken: credentials.jsToken });
}

/** Listing a directory that does not exist. */
const ERRNO_NOT_FOUND = -9;
/** Creating something whose name is already taken. */
const ERRNO_ALREADY_EXISTS = -8;

/**
 * Creating a directory that already exists does NOT fail on Terabox: the server
 * silently makes a twin named `<dir>_YYYYMMDD_HHMMSS`, so a blind create on every
 * run litters the account with empty folders. Look before leaping, and pass
 * `rtype=0` so a concurrent creator collides instead of getting another twin.
 */
export async function ensureRemoteDir(
  remoteDir: string,
  credentials: TeraboxCredentials,
  appId: string,
): Promise<void> {
  try {
    await listRemoteFiles(remoteDir, credentials, appId);
    return;
  } catch (error) {
    if (!(error instanceof TeraboxApiError) || error.errno !== ERRNO_NOT_FOUND) {
      throw error;
    }
  }

  logger.info("Creating the remote directory", { remoteDir });

  try {
    await postForm(
      apiUrl("/api/create", credentials, newDpLogId(), appId),
      new URLSearchParams({
        path: remoteDir,
        isdir: "1",
        size: "0",
        block_list: "[]",
        local_mtime: String(Math.floor(Date.now() / 1000)),
        rtype: "0",
      }),
      credentials.ndus,
      "create directory",
    );
  } catch (error) {
    if (error instanceof TeraboxApiError && error.errno === ERRNO_ALREADY_EXISTS) {
      return;
    }

    throw error;
  }
}

export async function listRemoteFiles(
  remoteDir: string,
  credentials: TeraboxCredentials,
  appId: string,
): Promise<TeraboxFileEntry[]> {
  const result = await uploader(credentials, appId).fetchFileList(remoteDir);

  // The library swallows failures into `{ success: false }` and reports errno inside `data`.
  if (!result.success) {
    throw new Error(`Terabox list failed: ${JSON.stringify(result.message)}`);
  }

  const errno = result.data?.errno;

  if (typeof errno === "number" && errno !== 0) {
    throw new TeraboxApiError("list", errno, result.data?.errmsg);
  }

  return result.data?.list ?? [];
}

export async function deleteRemoteFiles(
  paths: string[],
  credentials: TeraboxCredentials,
  appId: string,
): Promise<void> {
  if (paths.length === 0) {
    return;
  }

  const result = await uploader(credentials, appId).deleteFiles(paths);

  // `deleteFiles` reports success even when the API refused, so errno is the real check.
  if (!result.success) {
    throw new Error(`Terabox delete failed: ${JSON.stringify(result.message)}`);
  }

  const errno = result.result?.errno;

  if (typeof errno === "number" && errno !== 0) {
    throw new TeraboxApiError("delete", errno, result.result?.errmsg);
  }
}
