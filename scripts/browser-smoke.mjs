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
    parseFloat(await page.locator("#compCard").evaluate(
      element => getComputedStyle(element).borderTopLeftRadius,
    )) > 0,
    "the result summary should render as a complete card",
  );
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

  const firstIdentity = await page.locator(
    "#upgradeBuildEditor .upgrade-piece-identity",
  ).first().innerText();
  assert.match(firstIdentity, /-5/, "piece summary should name the -5 stat");
  assert.match(firstIdentity, /\+10/, "piece summary should name the +10 stat mod");

  const initialBudget = await page.locator("#upgradeTargetBudget").evaluate(
    element => ({
      available: Number(element.dataset.available),
      required: Number(element.dataset.required),
      remaining: Number(element.dataset.remaining),
    }),
  );
  assert.equal(initialBudget.available, 500);
  assert.equal(initialBudget.remaining, initialBudget.available - initialBudget.required);

  await page.evaluate(() => window.updateUpgradePiece(2, "locked", true, true));
  const identityLeftEdges = await page.locator(
    "#upgradeBuildEditor .upgrade-piece-identity",
  ).evaluateAll(elements => elements.map(element => element.getBoundingClientRect().left));
  assert.ok(
    Math.max(...identityLeftEdges) - Math.min(...identityLeftEdges) <= 1,
    "locking a piece should not shift the identity column: " +
      JSON.stringify(identityLeftEdges),
  );

  await page.locator("#pageLanguage").selectOption("en");
  const englishIdentity = await page.locator(
    "#upgradeBuildEditor .upgrade-piece-identity",
  ).first().innerText();
  assert.match(englishIdentity, /Tuning -5/);
  assert.match(englishIdentity, /Mod \+10/);
  const englishIdentityLeftEdges = await page.locator(
    "#upgradeBuildEditor .upgrade-piece-identity",
  ).evaluateAll(elements => elements.map(element => element.getBoundingClientRect().left));
  assert.ok(
    Math.max(...englishIdentityLeftEdges) - Math.min(...englishIdentityLeftEdges) <= 1,
    "English labels should keep the identity column aligned: " +
      JSON.stringify(englishIdentityLeftEdges),
  );

  await page.locator("#targetGrid input[type=number]").evaluateAll(elements => {
    for (const element of elements) {
      element.value = "200";
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  assert.ok(
    Number(await page.locator("#upgradeTargetBudget").getAttribute("data-remaining")) < 0,
    "target budget should report an over-budget target set",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => window.setCalculatorMode("upgrade"));
  const mobilePieceSummary = await page.locator(
    "#upgradeBuildEditor .upgrade-piece-row summary",
  ).first().evaluate(element => {
    const box = selector => {
      const rect = element.querySelector(selector).getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, width: rect.width };
    };
    return {
      slot: box(".upgrade-piece-slot"),
      identity: box(".upgrade-piece-identity"),
      status: box(".upgrade-piece-status"),
    };
  });
  assert.ok(
    Math.abs(mobilePieceSummary.slot.top - mobilePieceSummary.status.top) <= 4,
    "mobile piece status should share the first summary row with its slot",
  );
  assert.ok(
    mobilePieceSummary.identity.top >= mobilePieceSummary.slot.bottom,
    "mobile piece identity should get a dedicated readable row",
  );

  await page.evaluate(async () => {
    window.setCalculatorMode("solve");
    window.resetTargetStats();
    await window.solve();
  });
  await page.locator("#results.show").waitFor();
  await page.locator(".constraint-scroll-hint").waitFor({ state: "visible" });
  assert.equal(
    await page.locator(".constraint-matrix").getAttribute("tabindex"),
    "0",
    "the horizontally scrollable constraint table should be keyboard reachable",
  );
  await page.locator(".footer").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => (
    document.getElementById("floatJump").classList.contains("is-footer-visible")
  ));
  assert.equal(
    await page.locator("#floatJump").evaluate(
      element => getComputedStyle(element).pointerEvents,
    ),
    "none",
    "floating result controls should not cover footer links",
  );
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
