// Layout / whitespace audit.
//
// Companion to `browser-smoke.mjs`: that suite asserts the workspace keeps one
// measure and that the dense regions stay structural; this script is the
// measuring tape. It walks the viewport sweep, captures input and result
// states, and prints how much of each region's own width its content actually
// uses — the "wide container, left-aligned scrap of text, empty right half"
// smell that a pure overflow check cannot see.
//
// Usage: npm run build && node scripts/layout-audit.mjs [--shots <dir>]
//
// Requires a local Chrome/Edge (same resolution order as the smoke suite).

import { access, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright-core";
import { preview } from "vite";
import { BASE_CONFIGS } from "../src/core/armor-model.mjs";
import { channelStorageKey } from "../src/core/build-channel.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VIEWPORTS = [1920, 1440, 1280, 1024, 800, 600, 390];
const screenshotDir = (() => {
  const index = process.argv.indexOf("--shots");
  return index >= 0 && process.argv[index + 1]
    ? path.resolve(process.argv[index + 1])
    : path.join(projectRoot, ".layout-audit");
})();

const channel = process.env.BUILD_CHANNEL === "develop" ? "develop" : "stable";
const storageKeys = {
  upgradeDraft: channelStorageKey("d2_armor_upgrade_draft_v1", channel),
  calculatorMode: channelStorageKey("d2_armor_calculator_mode_v1", channel),
};

// Regions worth auditing: everything that used to hold one short line of copy
// inside a full-width container.
const REGIONS = [
  [".armor-source-head", "owned-armor header"],
  [".armor-filter-toolbar", "import status + filters"],
  [".advanced-constraints-body", "advanced constraints"],
  [".upgrade-card-header", "five-piece header"],
  [".upgrade-piece-list", "five-piece rows"],
  [".target-strip-card", "target strip"],
  ["#comparisonGrid", "target six stats"],
  [".upgrade-stat-comparison", "result six stats"],
  [".upgrade-hero", "result hero"],
  [".upgrade-plan-step", "replacement step"],
];

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
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

// For each region: how far its right-most descendant reaches, compared with the
// region's own right edge. A large unused share on a wide viewport is the
// signature of content that never learned the container got wider.
async function auditRegions(page) {
  return page.evaluate((pairs) => {
    const results = [];
    for (const [selector, label] of pairs) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const box = element.getBoundingClientRect();
      if (box.width < 40 || box.height < 8) continue;
      let reach = box.left;
      for (const child of element.querySelectorAll("*")) {
        const rect = child.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.top > box.bottom || rect.bottom < box.top) continue;
        reach = Math.max(reach, rect.right);
      }
      results.push({
        label,
        width: Math.round(box.width),
        used: Math.round(reach - box.left),
        unused: Math.round(box.right - reach),
      });
    }
    return results;
  }, REGIONS);
}

async function readDocument(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const container = document.querySelector(".container")?.getBoundingClientRect();
    return {
      viewport: doc.clientWidth,
      content: doc.scrollWidth,
      containerWidth: container ? Math.round(container.width) : null,
      containerLeft: container ? Math.round(container.left) : null,
      overflow: doc.scrollWidth - doc.clientWidth,
    };
  });
}

const server = await preview({
  configFile: path.join(projectRoot, "vite.config.mjs"),
  logLevel: "silent",
  preview: { host: "127.0.0.1", port: 4331, strictPort: false },
});
const address = server.httpServer.address();
const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 4331}/app/`;

await mkdir(screenshotDir, { recursive: true });
const browser = await chromium.launch({ executablePath: await findChrome(), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));

const report = [];
try {
  for (const width of VIEWPORTS) {
    const height = width <= 800 ? 720 : 1000;
    await page.setViewportSize({ width, height });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(({ keys }) => {
      localStorage.removeItem(keys.upgradeDraft);
    }, { keys: storageKeys });
    await page.reload({ waitUntil: "networkidle" });

    const inputDoc = await readDocument(page);
    await page.screenshot({ path: path.join(screenshotDir, `input-${width}.png`), fullPage: true });
    const inputRegions = await auditRegions(page);

    await page.locator("#advancedConstraints > summary").click();
    await page.locator("#advancedConstraints[open]").waitFor();
    await page.screenshot({ path: path.join(screenshotDir, `input-open-${width}.png`), fullPage: true });
    const openRegions = await auditRegions(page);

    await page.evaluate(({ keys, configs }) => {
      const slots = ["helmet", "arms", "chest", "legs", "classItem"];
      const archetypes = [
        "Siegebreaker", "Bulwark", "Brawler", "Skirmisher", "Grenadier", "Demolitionist",
        "Colossus", "Paragon", "Reaver", "Specialist", "Gunner", "Powerhouse",
      ];
      const stats = ["health", "melee", "grenade", "super", "class", "weapons"];
      const inventory = [];
      let id = 0;
      for (const slot of slots) {
        for (const archetypeId of archetypes) {
          for (const tertiary of stats) {
            const config = configs.find(entry => entry.archetype === archetypeId && entry.tertiary === tertiary);
            if (!config) continue;
            for (const tuningTo of stats) {
              inventory.push({
                id: `audit-${id++}`,
                hash: 700000 + id,
                name: `Owned ${slot} ${archetypeId} ${tertiary} ${tuningTo}`,
                slot,
                classId: "hunter",
                tier: "5",
                exotic: false,
                archetypeId,
                tertiary,
                tuningMode: "shift",
                tuningFrom: "health",
                tuningTo,
                armorModSize: 10,
                armorModStat: "weapons",
                baseStats: { ...config.baseStats },
                effectiveBaseStats: { ...config.baseStats },
                optimizationBaseStats: { ...config.baseStats },
                masterworkTier: 5,
                setHash: null,
              });
            }
          }
        }
      }
      localStorage.setItem(keys.upgradeDraft, JSON.stringify({
        schemaVersion: 1, pieces: [], inventory, setRequirement: { type: "none" },
        manualLocked: [], importClassFilter: "hunter", importTier5Only: true, reassignModifiers: true,
      }));
    }, { keys: storageKeys, configs: BASE_CONFIGS });
    await page.reload({ waitUntil: "networkidle" });
    await page.evaluate(() => window.setCalculatorMode("upgrade"));
    await page.locator("#btnUpgradeAnalyze").click();
    await page.locator("#upgradeResults:not([hidden])").waitFor({ timeout: 60000 });
    await page.locator("#btnUpgradeAnalyze:not([disabled])").waitFor({ timeout: 60000 });
    await page.waitForTimeout(250);

    const resultDoc = await readDocument(page);
    await page.locator("#upgradeResults").screenshot({
      path: path.join(screenshotDir, `result-${width}.png`),
    }).catch(() => {});
    await page.screenshot({ path: path.join(screenshotDir, `page-${width}.png`), fullPage: true });
    const resultRegions = await auditRegions(page);

    report.push({ width, inputDoc, resultDoc, inputRegions, openRegions, resultRegions });
    process.stdout.write(`audited ${width}px\n`);
  }
} finally {
  await browser.close();
  await server.close();
}

const worst = [];
for (const entry of report) {
  for (const region of [...entry.openRegions, ...entry.resultRegions]) {
    // Ignore rows that are legitimately short: the smell is a wide region whose
    // content stops far short of its own right edge.
    if (region.width >= 600 && region.unused >= 220) {
      worst.push({ width: entry.width, ...region });
    }
  }
}

console.log("\n=== container geometry ===");
for (const entry of report) {
  console.log(
    `${String(entry.width).padStart(5)}px  container ${String(entry.inputDoc.containerWidth).padStart(5)} → `
    + `${String(entry.resultDoc.containerWidth).padStart(5)}  left ${entry.inputDoc.containerLeft} → ${entry.resultDoc.containerLeft}  `
    + `overflow ${entry.resultDoc.overflow}px`,
  );
}

console.log("\n=== wide regions with unused right space (>=220px and >=600px wide) ===");
if (worst.length === 0) console.log("none");
for (const entry of worst) {
  console.log(`${String(entry.width).padStart(5)}px  ${entry.label.padEnd(28)} width ${String(entry.width).padStart(5)}  unused ${String(entry.unused).padStart(5)}`);
}

if (errors.length > 0) {
  console.log("\n=== page errors ===");
  for (const error of errors) console.log(error);
}
console.log(`\nscreenshots: ${screenshotDir}`);
