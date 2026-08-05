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
