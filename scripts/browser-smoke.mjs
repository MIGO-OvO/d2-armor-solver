import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright-core";
import { preview } from "vite";

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
const server = await preview({
  configFile: path.join(projectRoot, "vite.config.mjs"),
  logLevel: "silent",
  preview: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: false,
  },
});
const address = server.httpServer.address();
const port = typeof address === "object" && address ? address.port : 4174;
const baseUrl = "http://127.0.0.1:" + port + "/";

let browser;
try {
  browser = await chromium.launch({
    executablePath: await findChrome(),
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__armorWorkerUrls = [];
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args) {
        window.__armorWorkerUrls.push(String(args[0]));
        return Reflect.construct(target, args);
      },
    });
  });

  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  assert.equal(await page.locator("#targetGrid input[type=number]").count(), 6);
  assert.equal(await page.locator("#fragmentGrid .fragment-stepper").count(), 6);

  await page.evaluate(() => window.solve());
  await page.locator("#results.show").waitFor();
  assert.equal(await page.locator("#comparisonGrid .comp-item").count(), 6);
  assert.ok(
    (await page.evaluate(() => window.__armorWorkerUrls))
      .some(url => url.includes("armor-engine.worker")),
    "the solver should execute through the Worker Adapter",
  );

  await page.evaluate(() => window.setCalculatorMode("upgrade"));
  assert.equal(await page.locator("#upgradeBuildCard").getAttribute("hidden"), null);
  const upgradeRows = await page.locator(
    "#upgradeBuildEditor .upgrade-piece-row",
  ).count();
  if (upgradeRows !== 5) {
    console.error(await page.evaluate(() => ({
      editor: document.getElementById("upgradeBuildEditor")?.innerHTML,
      mode: document.body.className,
      exposed: typeof window.updateUpgradePiece,
    })));
    console.error(browserErrors);
  }
  assert.equal(upgradeRows, 5);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  const overflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll("body *")]
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.right > document.documentElement.clientWidth + 1 ||
          rect.left < -1;
      })
      .slice(0, 8)
      .map(element => ({
        tag: element.tagName,
        id: element.id,
        className: String(element.className || ""),
        right: Math.round(element.getBoundingClientRect().right),
      })),
  }));
  assert.ok(
    overflow.content <= overflow.viewport + 1,
    "390px viewport overflows: " + JSON.stringify(overflow),
  );

  assert.deepEqual(browserErrors, []);
  console.log("browser smoke OK (Worker solve, mode switch, 390px layout)");
} finally {
  await browser?.close();
  await server.close();
}
