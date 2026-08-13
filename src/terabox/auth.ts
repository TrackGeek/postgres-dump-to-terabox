import { existsSync, readFileSync } from "node:fs";
import { logger } from "../logger";
import {
  cookieHeader,
  isNetworkFailure,
  NetworkError,
  SessionExpiredError,
  TERABOX_ORIGIN,
  USER_AGENT,
} from "./constants";

export interface TeraboxCredentials {
  ndus: string;
  jsToken: string;
  source: "fetch" | "playwright";
}

interface StorageState {
  cookies?: Array<{ name: string; value: string; domain?: string }>;
}

interface Session {
  ndus: string;
  cookies: string;
}

const MAIN_PAGE_URL = `${TERABOX_ORIGIN}/main?category=all`;

/** A resolver that is only briefly deaf (EAI_AGAIN right after boot) deserves a second chance. */
const FETCH_ATTEMPTS = 2;
const FETCH_RETRY_DELAY_MS = 2000;

/**
 * Terabox embeds the token in the page as the URL-encoded call `fn("<TOKEN>")`.
 */
const JS_TOKEN_PATTERN = /fn%28%22([0-9A-Fa-f]{16,})%22%29/;

/**
 * The login page carries a jsToken of its own, so a token alone proves nothing —
 * landing on /login means the session is dead, no matter what was extracted.
 */
function isLoggedOut(url: string): boolean {
  try {
    return /^\/(login|passport)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function readSession(storageStatePath: string): Session {
  if (!existsSync(storageStatePath)) {
    throw new SessionExpiredError(`Storage state not found at ${storageStatePath}.`);
  }

  let state: StorageState;

  try {
    state = JSON.parse(readFileSync(storageStatePath, "utf8"));
  } catch {
    throw new SessionExpiredError(`Storage state at ${storageStatePath} is not valid JSON.`);
  }

  const cookies = state.cookies ?? [];
  const ndus = cookies.find((cookie) => cookie.name === "ndus")?.value;

  if (!ndus) {
    throw new SessionExpiredError(`No "ndus" cookie in ${storageStatePath}.`);
  }

  // Replay every terabox cookie, not just ndus: some of them gate the /main page.
  const teraboxCookies = cookies.filter((cookie) => (cookie.domain ?? "").includes("terabox"));
  const header =
    teraboxCookies.length > 0
      ? `lang=en; ${teraboxCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")};`
      : cookieHeader(ndus);

  return { ndus, cookies: header };
}

async function fetchMainPage(session: Session): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await fetch(MAIN_PAGE_URL, {
        headers: {
          Cookie: session.cookies,
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
      });
    } catch (error) {
      lastError = error;

      if (attempt < FETCH_ATTEMPTS) {
        logger.warn("Terabox main page request failed, retrying", {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAY_MS));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function jsTokenViaFetch(session: Session): Promise<string | null> {
  const response = await fetchMainPage(session);

  if (!response.ok) {
    logger.warn("Terabox main page returned a non-OK status", { status: response.status });
    return null;
  }

  if (isLoggedOut(response.url)) {
    logger.warn("Terabox redirected the main page to login", { url: response.url });
    return null;
  }

  return JS_TOKEN_PATTERN.exec(await response.text())?.[1] ?? null;
}

/**
 * Fallback for when the HTML layout changes: rehydrate the saved session in a real
 * browser and read the token the page itself computed. Never logs in, so no CAPTCHA.
 */
async function jsTokenViaPlaywright(storageStatePath: string): Promise<string | null> {
  const { chromium } = await import("playwright");
  // Chromium's built-in async resolver ignores part of the container's DNS setup and
  // fails with ERR_NAME_NOT_RESOLVED where getaddrinfo (and therefore fetch) succeeds.
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-features=AsyncDns", "--dns-prefetch-disable"],
  });

  try {
    const context = await browser.newContext({ storageState: storageStatePath, userAgent: USER_AGENT });
    const page = await context.newPage();

    await page.goto(MAIN_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    if (isLoggedOut(page.url())) {
      throw new SessionExpiredError("Terabox redirected the saved session to the login page.");
    }

    const fromWindow = await page.evaluate(() => (globalThis as any).jsToken as string | undefined);

    if (typeof fromWindow === "string" && fromWindow.length >= 16) {
      return fromWindow;
    }

    const html = await page.content();

    return JS_TOKEN_PATTERN.exec(html)?.[1] ?? JS_TOKEN_PATTERN.exec(encodeURIComponent(html))?.[1] ?? null;
  } finally {
    await browser.close();
  }
}

export async function getCredentials(storageStatePath: string): Promise<TeraboxCredentials> {
  const session = readSession(storageStatePath);

  try {
    const jsToken = await jsTokenViaFetch(session);

    if (jsToken) {
      return { ndus: session.ndus, jsToken, source: "fetch" };
    }

    logger.warn("jsToken not found in the fetched HTML, falling back to Playwright");
  } catch (error) {
    // Playwright goes out over the same network stack, so retrying there only buys
    // a 60 s timeout and an error that blames the session for a DNS problem.
    if (isNetworkFailure(error)) {
      throw new NetworkError(
        `Could not reach ${TERABOX_ORIGIN}: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }

    logger.warn("Fetching the Terabox main page failed, falling back to Playwright", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let jsToken: string | null;

  try {
    jsToken = await jsTokenViaPlaywright(storageStatePath);
  } catch (error) {
    if (isNetworkFailure(error)) {
      throw new NetworkError(
        `Could not reach ${TERABOX_ORIGIN} from the browser: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }

    throw error;
  }

  if (!jsToken) {
    throw new SessionExpiredError("Could not extract a jsToken through fetch or Playwright.");
  }

  return { ndus: session.ndus, jsToken, source: "playwright" };
}
