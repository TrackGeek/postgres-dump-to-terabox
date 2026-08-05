import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { config } from "../src/config";
import { TERABOX_ORIGIN } from "../src/terabox/constants";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

async function main() {
  const storageStatePath = config.terabox.storageStatePath;

  console.log("Opening Terabox. Log in manually in the browser window that just opened.");
  console.log(`The session will be saved to ${storageStatePath} once the "ndus" cookie appears.\n`);

  const browser = await chromium.launch({ headless: false });

  try {
    const context = await browser.newContext({
      storageState: existsSync(storageStatePath) ? storageStatePath : undefined,
    });
    const page = await context.newPage();

    await page.goto(`${TERABOX_ORIGIN}/main?category=all`, { waitUntil: "domcontentloaded" });

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let found = false;

    while (Date.now() < deadline) {
      const cookies = await context.cookies();

      if (cookies.some((cookie) => cookie.name === "ndus" && cookie.value.length > 0)) {
        found = true;
        break;
      }

      await page.waitForTimeout(2000);
    }

    if (!found) {
      throw new Error(`Timed out after ${LOGIN_TIMEOUT_MS / 60000} minutes waiting for the "ndus" cookie.`);
    }

    // Give the SPA a moment to finish writing the rest of the session cookies.
    await page.waitForTimeout(3000);

    mkdirSync(dirname(storageStatePath), { recursive: true });
    await context.storageState({ path: storageStatePath });
    chmodSync(storageStatePath, 0o600);

    console.log(`\nSession saved to ${storageStatePath}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
