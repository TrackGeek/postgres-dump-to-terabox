type Level = "info" | "warn" | "error";

function line(level: Level, message: string, meta?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";

  return `${timestamp} [${level.toUpperCase()}] ${message}${suffix}`;
}

export const logger = {
  info(message: string, meta?: Record<string, unknown>) {
    console.log(line("info", message, meta));
  },
  warn(message: string, meta?: Record<string, unknown>) {
    console.warn(line("warn", message, meta));
  },
  error(message: string, meta?: Record<string, unknown>) {
    console.error(line("error", message, meta));
  },
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }

  const seconds = ms / 1000;

  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);

  return `${minutes}m ${rest}s`;
}
