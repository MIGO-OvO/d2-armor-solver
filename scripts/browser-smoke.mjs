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

async function checkInventoryPlanning(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => {
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
            for (const tuningTo of stats) {
              inventory.push({
                id: `plan-regression-${id++}`,
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
                baseStats: {},
                setHash: null,
              });
            }
          }
        }
      }
      inventory.push({
        id: "plan-regression-exotic",
        hash: 910001,
        name: "Regression Exotic",
        slot: "helmet",
        classId: "hunter",
        tier: "5",
        exotic: true,
        archetypeId: "Siegebreaker",
        tertiary: "health",
        tuningMode: "shift",
        tuningFrom: "melee",
        tuningTo: "grenade",
        armorModSize: 10,
        armorModStat: "weapons",
        baseStats: {},
        setHash: null,
      });
      localStorage.setItem("d2_armor_upgrade_draft_v1", JSON.stringify({
        schemaVersion: 1,
        pieces: [],
        inventory,
        setRequirement: { type: "none" },
        manualLocked: [],
        importClassFilter: "hunter",
        importTier5Only: true,
        reassignModifiers: true,
      }));
      localStorage.setItem("d2_armor_calculator_mode_v1", "solve");
    });
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(
      await page.locator('.upgrade-import-actions button[onclick*="applyEquippedLoadout"]').count(),
      0,
      "scratch mode should not expose the equipped-loadout filler",
    );
    await page.evaluate(() => window.setCalculatorMode("upgrade"));
    const panelOrder = await page.evaluate(() => {
      const importCard = document.getElementById("inventoryImportCard").getBoundingClientRect();
      const upgradeCard = document.getElementById("upgradeBuildCard").getBoundingClientRect();
      return { importTop: importCard.top, upgradeTop: upgradeCard.top };
    });
    assert.ok(
      panelOrder.importTop < panelOrder.upgradeTop,
      "DIM import should stay above the current-loadout editor in both modes",
    );
    await page.evaluate(() => window.setCalculatorMode("solve"));
    await page.locator("#pageLanguage").selectOption("en");
    await page.locator("#onlyPlus5Tuning").check();
    await page.locator("#inventoryExoticSlotFilter").selectOption("helmet");
    const fixedExoticValue = await page.locator("#inventoryFixedExoticName option", { hasText: "Regression Exotic" }).getAttribute("value");
    assert.ok(fixedExoticValue, "imported Exotic should be available by name");
    await page.locator("#inventoryFixedExoticName").selectOption(fixedExoticValue);
    await page.evaluate(() => window.solve());
    await page.locator("#inventoryPlanResults:not([hidden])").waitFor();
    assert.match(
      await page.locator("#inventoryPlanResults").innerText(),
      /owned|farm/i,
      "standard solve should render inventory plan counts",
    );
    assert.ok(
      await page.locator("#inventoryPlanResults .inventory-plan-piece.is-farm").count() > 0,
      "a fixed Exotic slot without owned Exotics should produce a farm item",
    );
    assert.match(
      await page.locator("#inventoryPlanResults .inventory-plan-piece.is-farm").first().innerText(),
      /Exotic|frame/i,
      "missing fixed Exotic should explain the frame to farm",
    );
    await page.locator("#useExoticMode").check();
    assert.equal(
      await page.locator("#inventoryExoticSlotFilter").isDisabled(),
      true,
      "Exotic Class Item mode should disable regular Exotic slot selection",
    );
    assert.deepEqual(browserErrors, []);
  } finally {
    await context.close();
  }
}

async function checkUpgradeTargetSync(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      const slots = ["helmet", "arms", "chest", "legs", "classItem"];
      const setHash = 741162535;
      const baseStats = {
        health: 0,
        melee: 0,
        grenade: 20,
        super: 25,
        class: 0,
        weapons: 30,
      };
      const inventory = slots.map((slot, index) => ({
        id: `regression-${slot}`,
        hash: 900000 + index,
        name: `Regression ${slot}`,
        slot,
        classId: "hunter",
        tier: "5",
        exotic: false,
        archetypeId: "Gunner",
        tertiary: "super",
        tuningMode: "shift",
        tuningFrom: "health",
        tuningTo: "melee",
        armorModSize: 10,
        armorModStat: "weapons",
        baseStats,
        setHash,
      }));
      const pieces = inventory.map(item => ({
        slot: item.slot,
        archetypeId: item.archetypeId,
        tertiary: item.tertiary,
        tuningMode: item.tuningMode,
        tuningFrom: item.tuningFrom,
        tuningTo: item.tuningTo,
        armorModSize: item.armorModSize,
        armorModStat: item.armorModStat,
        exotic: false,
        locked: false,
        baseStats: item.baseStats,
        setHash: item.setHash,
        itemName: item.name,
        sourceId: item.id,
        hash: item.hash,
      }));
      localStorage.setItem("d2_armor_upgrade_draft_v1", JSON.stringify({
        schemaVersion: 1,
        pieces,
        inventory,
        setRequirement: { type: "none" },
        manualLocked: [true, true, true, true, false],
        importClassFilter: "hunter",
        importTier5Only: true,
        reassignModifiers: true,
      }));
      localStorage.setItem("d2_armor_calculator_mode_v1", "upgrade");
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.locator("#pageLanguage").selectOption("zh-chs");
    await page.locator("#upgradeRequired_weapons").check();
    assert.equal(
      await page.locator("#upgradeRequired_weapons").isVisible(),
      true,
      "upgrade mode should expose a per-stat must-meet constraint",
    );
    await page.locator("#target_weapons").evaluate(element => {
      element.value = "180";
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.locator("#target_health").evaluate(element => {
      element.value = "80";
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.evaluate(() => window.analyzeArmorUpgrades());
    await page.locator("#upgradeResults:not([hidden])").waitFor();

    await page.locator("#target_health").evaluate(element => {
      element.value = "135";
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.locator("#setReqMode").selectOption("set4");
    await page.evaluate(() => window.analyzeArmorUpgrades());
    assert.match(
      await page.locator("#upgradeResultsBody .upgrade-stat").first().innerText(),
      /目标\s*135/,
      "replacement advice should be recalculated with the latest stat targets",
    );
    assert.equal(
      await page.locator(".inventory-results-title").innerText(),
      "已有护甲搭配方案",
    );
    assert.match(
      await page.locator("#upgradeResultsBody .upgrade-requirement-result").innerText(),
      /武器\s+\d+\/180/,
      "replacement advice should explain the must-meet result",
    );
    assert.ok(
      await page.locator("#upgradeResultsBody .upgrade-stat.is-required").count() >= 1,
      "must-meet stats should remain visually identifiable in the result",
    );
    assert.deepEqual(browserErrors, []);
  } finally {
    await context.close();
  }
}

async function checkSetRequirementSnapshot(browser) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await context.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class DelayedWorker extends NativeWorker {
      addEventListener(type, listener, options) {
        if (type !== "message") return super.addEventListener(type, listener, options);
        return super.addEventListener(
          type,
          event => setTimeout(() => listener.call(this, event), 400),
          options,
        );
      }
    };
  });
  const page = await context.newPage();

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      const requiredSet = 741162535;
      const otherSet = 499993704;
      const slots = ["helmet", "arms", "chest", "legs", "classItem"];
      const baseStats = {
        health: 0,
        melee: 0,
        grenade: 20,
        super: 25,
        class: 0,
        weapons: 30,
      };
      const makeItem = (slot, setHash, suffix, exotic = false) => ({
        id: `${slot}-${suffix}`,
        hash: 810000 + suffix,
        name: `${setHash === requiredSet ? "Atheon" : setHash === otherSet ? "Luminopotent" : "Exotic"} ${slot}`,
        slot,
        classId: "hunter",
        tier: "5",
        exotic,
        archetypeId: "Gunner",
        tertiary: "super",
        tuningMode: "shift",
        tuningFrom: "health",
        tuningTo: "melee",
        armorModSize: 10,
        armorModStat: "weapons",
        baseStats,
        setHash,
      });
      const inventory = [];
      const currentItems = [];
      slots.forEach((slot, index) => {
        if (slot === "classItem") {
          const exotic = makeItem(slot, null, 90, true);
          inventory.push(exotic);
          currentItems.push(exotic);
          return;
        }
        const currentSet = slot === "helmet" ? otherSet : requiredSet;
        const current = makeItem(slot, currentSet, index * 10 + 1);
        inventory.push(
          current,
          makeItem(slot, currentSet === requiredSet ? otherSet : requiredSet, index * 10 + 2),
        );
        currentItems.push(current);
      });
      const pieces = currentItems.map(item => ({
        slot: item.slot,
        archetypeId: item.archetypeId,
        tertiary: item.tertiary,
        tuningMode: item.tuningMode,
        tuningFrom: item.tuningFrom,
        tuningTo: item.tuningTo,
        armorModSize: item.armorModSize,
        armorModStat: item.armorModStat,
        exotic: item.exotic,
        locked: item.exotic,
        baseStats: item.baseStats,
        setHash: item.setHash,
        itemName: item.name,
        sourceId: item.id,
        hash: item.hash,
      }));
      localStorage.setItem("d2_armor_upgrade_draft_v1", JSON.stringify({
        schemaVersion: 1,
        pieces,
        inventory,
        setRequirement: { type: "none" },
        manualLocked: [],
        importClassFilter: "hunter",
        importTier5Only: true,
        reassignModifiers: true,
      }));
      localStorage.setItem("d2_armor_calculator_mode_v1", "upgrade");
    });
    await page.reload({ waitUntil: "networkidle" });

    const staleSolve = page.evaluate(() => window.analyzeArmorUpgrades());
    await page.waitForTimeout(25);
    await page.evaluate(() => window.updateSetRequirementMode("set4"));
    await staleSolve;
    assert.equal(
      await page.locator("#inventoryResults").isHidden(),
      true,
      "an inventory result solved under an old set requirement must be discarded",
    );

    await page.evaluate(() => window.analyzeArmorUpgrades());
    await page.locator("#inventoryResults:not([hidden])").waitFor();
    assert.match(await page.locator(".inventory-results-req").innerText(), /埃希恩记忆\s*4\s*件套/);
    assert.equal(
      await page.locator(".inventory-result-detail .upgrade-set-badge", { hasText: "埃希恩记忆" }).count(),
      4,
      "a four-piece requirement must render four matching set badges",
    );
    assert.equal(
      await page.locator(".inventory-result-current").count(),
      0,
      "a current loadout with only three matching pieces must not be offered",
    );
  } finally {
    await context.close();
  }
}

let browser;
try {
  browser = await chromium.launch({
    executablePath: await findChrome(),
    headless: true,
  });
  await checkInventoryPlanning(browser);
  await checkUpgradeTargetSync(browser);
  await checkSetRequirementSnapshot(browser);
  if (process.argv.includes("--target-sync-only")) {
    console.log("upgrade target sync and set requirement browser regressions OK");
  } else {
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

  await page.locator("#onlyPlus5Tuning").check();
  assert.equal(
    await page.locator("#usePlus3").isDisabled(),
    true,
    "+5/-5-only preference should disable the +3 control",
  );
  assert.equal(
    await page.locator("#plus3CountRow").evaluate(element => getComputedStyle(element).display),
    "none",
    "+5/-5-only preference should hide the +3 piece counter",
  );
  await page.waitForFunction(() => (
    JSON.parse(localStorage.getItem("d2_armor_current_draft_v1") || "null")
      ?.onlyPlus5Tuning === true
  ));
  await page.evaluate(() => window.solve());
  await page.locator("#results.show").waitFor();
  assert.equal(await page.locator("#comparisonGrid .comp-item").count(), 6);
  assert.doesNotMatch(
    await page.locator("#piecesOutput").innerText(),
    /\+3/,
    "+5/-5-only solutions should not contain +3 tuning",
  );
  await page.locator("#onlyPlus5Tuning").uncheck();
  assert.equal(await page.locator("#usePlus3").isDisabled(), false);
  await page.locator("#usePlus3").check();
  await page.locator("#onlyPlus5Tuning").check();
  assert.equal(
    await page.locator("#usePlus3").isChecked(),
    false,
    "+5/-5-only preference should clear an active +3 selection",
  );
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

  const firstModStat = page.locator(
    "#upgradeBuildEditor .upgrade-piece-row",
  ).first().locator(".upgrade-piece-fields select").nth(5);
  await firstModStat.selectOption("weapons");
  assert.match(
    await page.locator("#upgradeBuildEditor .upgrade-piece-identity").first().innerText(),
    /\+10武器/,
    "manually changing a +10 mod stat should refresh the collapsed summary",
  );

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
  const desktopPieceSummary = await page.locator(
    "#upgradeBuildEditor .upgrade-piece-row summary",
  ).first().evaluate(element => {
    const box = selector => {
      const rect = element.querySelector(selector).getBoundingClientRect();
      return { center: rect.top + rect.height / 2, height: rect.height };
    };
    return {
      slot: box(".upgrade-piece-slot"),
      identity: box(".upgrade-piece-identity"),
      status: box(".upgrade-piece-status"),
    };
  });
  assert.ok(
    Math.max(
      desktopPieceSummary.slot.center,
      desktopPieceSummary.identity.center,
      desktopPieceSummary.status.center,
    ) - Math.min(
      desktopPieceSummary.slot.center,
      desktopPieceSummary.identity.center,
      desktopPieceSummary.status.center,
    ) <= 2,
    "desktop piece summary content should share a visual center: " +
      JSON.stringify(desktopPieceSummary),
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
  const mobileLiveStats = await page.locator(".upgrade-live-stat").evaluateAll(elements =>
    elements.map(element => {
      const label = element.querySelector(".upgrade-live-stat-label").getBoundingClientRect();
      const output = element.querySelector("output").getBoundingClientRect();
      return {
        labelCenter: label.left + label.width / 2,
        outputCenter: output.left + output.width / 2,
        right: Math.max(label.right, output.right),
      };
    }),
  );
  assert.ok(
    mobileLiveStats.every(stat => Math.abs(stat.labelCenter - stat.outputCenter) <= 1),
    "mobile live stat labels and values should share a column center: " +
      JSON.stringify(mobileLiveStats),
  );
  assert.ok(
    mobileLiveStats.every(stat => stat.right <= 390),
    "mobile live stat content should stay inside the viewport: " +
      JSON.stringify(mobileLiveStats),
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
  console.log("browser smoke OK (Worker solve, mode switch, target sync, 390px layout)");
  }
} finally {
  await browser?.close();
  await server.close();
}
