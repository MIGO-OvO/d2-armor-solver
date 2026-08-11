import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright-core";

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : "/usr/bin/google-chrome",
    process.platform === "win32"
      ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
      : "/usr/bin/chromium",
    process.platform === "win32"
      ? "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
      : "/usr/bin/chromium-browser",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error("No Chrome/Edge executable found. Set CHROME_PATH.");
}

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
// pathToFileURL produces file:///D:/... on win32 and file:///... elsewhere.
const indexUrl = pathToFileURL(
  path.join(projectRoot, "dist-offline", "index.html"),
).href;

let browser;
try {
  browser = await chromium.launch({
    executablePath: await findChrome(),
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", error => browserErrors.push("pageerror: " + error.message));
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push("console: " + message.text());
  });

  await page.goto(indexUrl, { waitUntil: "load" });
  await page.locator("#pageTitle").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#btnSolve").count(),
    1,
    "#btnSolve should be present in the offline build",
  );
  await page.locator("#btnSolve").click();
  // Main-thread solving blocks the UI; give it a generous window.
  await page.locator("#results.show").waitFor({ timeout: 30000 });
  assert.ok(
    await page.locator("#comparisonGrid .comp-item").count() >= 1,
    "solving should produce a result comparison",
  );
  assert.deepEqual(
    browserErrors,
    [],
    "offline page must run with zero console/page errors",
  );
  console.log("offline verify OK: " + indexUrl);
} catch (error) {
  console.error("offline verify FAILED: " + error.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
