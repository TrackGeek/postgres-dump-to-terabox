export const TERABOX_ORIGIN = "https://www.1024terabox.com";
export const TERABOX_UPLOAD_ORIGIN = "https://c-jp.1024terabox.com";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function cookieHeader(ndus: string): string {
  return `lang=en; ndus=${ndus};`;
}

export class SessionExpiredError extends Error {
  constructor(message: string) {
    super(`${message} Run \`bun run login\` to refresh the Terabox session.`);
    this.name = "SessionExpiredError";
  }
}

/**
 * A dead network looks nothing like a dead session, but both used to surface as
 * "run `bun run login`" — which is the one thing that cannot fix DNS.
 */
export class NetworkError extends Error {
  constructor(message: string) {
    super(`${message} Check the container's DNS and connectivity (\`dns:\` in docker-compose, host VPN).`);
    this.name = "NetworkError";
  }
}

const NETWORK_FAILURE_MARKERS = [
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_CONNECTION_",
  "ERR_PROXY_CONNECTION_FAILED",
  "fetch failed",
  // Bun words a dead resolver differently on each attempt, and puts the machine-readable
  // part in `code`: ConnectionRefused first, FailedToOpenSocket on the retry.
  "Unable to connect",
  "Was there a typo in the url or port",
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
];

/**
 * Bun, Node and Chromium all word this differently, so match on any of their markers.
 * The `ERR_*` ones only ever come from `bun run login`, the single browser-driven step.
 */
export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof NetworkError) {
    return true;
  }

  const message =
    error instanceof Error ? `${error.message} ${(error as { code?: string }).code ?? ""}` : String(error);

  return NETWORK_FAILURE_MARKERS.some((marker) => message.includes(marker));
}
