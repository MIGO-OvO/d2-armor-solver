import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";

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

// Bungie GetProfile fixture, already shaped as { ErrorCode: 1, Response: ... }.
const syntheticProfileFixture = JSON.parse(
  readFileSync(
    path.join(projectRoot, "tests", "fixtures", "synthetic-profile-fixture.json"),
    "utf8",
  ),
);

// The Bungie secrets are injected at build time from the environment; the
// smoke test drives both states: a secret-less build (login hidden) and a
// build with fake secrets (full login/import flow, all bungie.net mocked).
function runBuild(env) {
  execSync("npm run build", { cwd: projectRoot, env, stdio: "inherit" });
}

let server;
let baseUrl;

async function startPreview() {
  server = await preview({
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
  baseUrl = "http://127.0.0.1:" + port + "/";
}

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
    assert.equal(
      await page.locator("#upgradeImportBody").count(),
      1,
      "the owned-armor import panel should expose a collapsible body",
    );
    assert.equal(
      await page.locator("#upgradeImportBody").isHidden(),
      true,
      "the owned-armor import panel should start collapsed without an import",
    );
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
      await page.locator("#upgradeImportBody").isVisible(),
      true,
      "a restored owned-armor import should open its controls",
    );
    await page.locator("#toggleInventoryImportButton").click();
    assert.equal(await page.locator("#upgradeImportBody").isHidden(), true);
    await page.locator("#toggleInventoryImportButton").click();
    assert.equal(await page.locator("#upgradeImportBody").isVisible(), true);
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
    await page.locator("#ownedGearSection").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#piecesCard > h2").innerText(),
      "Solution details",
      "the loadout card should describe itself as solution details",
    );
    assert.match(
      await page.locator("#piecesOutput .farm-requirements-title").innerText(),
      /Still to farm/,
      "solution details should retain the missing-armor section",
    );
    assert.ok(
      await page.locator("#piecesOutput .farm-requirement-row").count() > 0,
      "missing armor should be listed per slot",
    );
    assert.match(
      await page.locator("#piecesOutput .solution-tuning-primary").innerText(),
      /Fixed \+5/,
      "rolled +5 tuning should be the primary tuning information",
    );
    assert.match(
      await page.locator("#piecesOutput .solution-tuning-secondary").innerText(),
      /Suggested -5/,
      "freely selected -5 tuning should be visually secondary",
    );
    assert.equal(
      await page.locator("#inventoryPlanResults").count(),
      0,
      "scratch mode should not render a second inventory-plan list",
    );
    assert.match(
      await page.locator("#ownedGearSection").innerText(),
      /Owned (arms|chest|legs|classItem)/,
      "the active solution should list matching armor from the imported inventory",
    );
    await page.locator("#ownedGearSection .manual-owned-editor summary").click();
    await page.locator("#addManualOwnedButton").click();
    assert.ok(
      await page.locator("#ownedGearSection .manual-owned-list li").count() > 0,
      "manually added armor should immediately update the active solution",
    );
    await page.locator("#inventoryExoticSlotFilter").evaluate(element => {
      element.value = "classItem";
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(
      await page.locator("#useExoticMode").isChecked(),
      true,
      "choosing the class-item slot should enable Exotic Class Item mode",
    );
    assert.equal(
      await page.locator("#exoticClass").inputValue(),
      "hunter",
      "the imported class should drive the Exotic Class Item class",
    );
    assert.match(
      await page.locator("#inventoryFixedExoticName").innerText(),
      /Relativism/,
      "the class-item name should adapt to the selected class",
    );
    for (const [classId, classItemName] of [["titan", "Stoicism"], ["warlock", "Solipsism"]]) {
      await page.locator("#importClass").selectOption(classId);
      assert.equal(await page.locator("#exoticClass").inputValue(), classId);
      assert.match(
        await page.locator("#inventoryFixedExoticName").innerText(),
        new RegExp(classItemName),
        `the ${classId} class-item name should be selected automatically`,
      );
    }
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
        tuningMode: index === 3 ? "plus3" : "shift",
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
        onlyPlus5Tuning: true,
      }));
      localStorage.setItem("d2_armor_calculator_mode_v1", "upgrade");
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.locator("#pageLanguage").selectOption("zh-chs");
    assert.equal(await page.locator("#upgradeOnlyPlus5").isChecked(), true);
    assert.match(
      await page.locator("#upgradeBudgetSummary").innerText(),
      /最终方案不会使用 \+3/,
      "the current +3 piece should be distinguished from the restricted solved setup",
    );
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
    await page.evaluate(() => window.exportInventorySolution(0));
    const exportedMods = await page.locator(".dim-export-actions a").evaluate(element => {
      const encoded = new URL(element.href).searchParams.get("loadout");
      return JSON.parse(decodeURIComponent(encoded)).parameters.mods;
    });
    assert.equal(
      exportedMods.includes(3122197216),
      false,
      "+5/-5-only owned loadouts must not export the balanced +3 tuning mod",
    );

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

// Bungie login chrome must be absent when the build carries no secrets.
async function checkBungieLoginHidden(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const bungieRequests = [];
  page.on("request", request => {
    if (request.url().includes("www.bungie.net")) {
      bungieRequests.push(request.url());
    }
  });

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    assert.equal(
      await page.locator("#bungieAuthArea").innerText(),
      "",
      "a build without Bungie secrets must leave the auth area empty",
    );
    assert.equal(
      await page.locator("#bungieLoginButton").count(),
      0,
      "a build without Bungie secrets must not expose the login button",
    );
    assert.deepEqual(
      bungieRequests,
      [],
      "no bungie.net request may escape a secret-less build",
    );
  } finally {
    await context.close();
  }
}

// Full Bungie OAuth shell (T10/T11): login URL shape, mocked token exchange,
// memberships resolution, profile import, error classification, logout. Every
// bungie.net request is intercepted; anything outside the known mock set
// increments `unhandled` and fails the run.
async function checkBungieAuthFlow(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  const routeStats = { handled: 0, unhandled: 0 };
  const observedBungieRequests = [];
  const handledBungieRequests = [];
  const authorizeRequests = [];
  let profileMode = "ok"; // "ok" | "throttle" | "403" | "network"

  page.on("request", request => {
    if (request.url().includes("www.bungie.net")) {
      observedBungieRequests.push(request.url());
    }
  });

  const membershipsBody = JSON.stringify({
    Response: {
      destinyMemberships: [{
        membershipType: 3,
        membershipId: "222",
        crossSaveOverride: 0,
        displayName: "MockGuardian",
      }],
    },
    ErrorCode: 1,
  });
  const tokenBody = JSON.stringify({
    access_token: "mock-access",
    refresh_token: "mock-refresh",
    membership_id: "123",
    expires_in: 3600,
    refresh_expires_in: 7776000,
  });

  await page.route("**://www.bungie.net/**", async route => {
    const url = new URL(route.request().url());
    handledBungieRequests.push(route.request().url());
    routeStats.handled += 1;
    if (url.pathname === "/en/oauth/authorize") {
      // The login button navigates here: capture the request and bounce back
      // to the app without a real Bungie round-trip.
      authorizeRequests.push(route.request().url());
      return route.fulfill({ status: 302, headers: { location: baseUrl } });
    }
    if (url.pathname === "/Platform/App/OAuth/token/") {
      if (profileMode === "network") return route.abort();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: tokenBody,
      });
    }
    if (url.pathname.endsWith("/Destiny2/GetMembershipsForCurrentUser/")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: membershipsBody,
      });
    }
    if (/\/Destiny2\/\d+\/Profile\//.test(url.pathname)) {
      if (profileMode === "throttle") {
        // Tiny ThrottleSeconds keeps bungieFetch's retry sleeps negligible.
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ErrorCode: 36, ThrottleSeconds: 0.01 }),
        });
      }
      if (profileMode === "403") {
        return route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ ErrorCode: 161, ErrorStatus: "ApiKeyMissingOrInvalid" }),
        });
      }
      if (profileMode === "network") return route.abort();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(syntheticProfileFixture),
      });
    }
    routeStats.unhandled += 1;
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ ErrorCode: 404, ErrorStatus: "Mocked unknown bungie.net route" }),
    });
  });

  try {
    // --- (b) login button renders (three languages) and builds the authorize URL ---
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.locator("#bungieLoginButton").waitFor();
    assert.equal(
      await page.locator("#bungieLoginButton").innerText(),
      "Bungie 登录",
      "zh-chs should label the Bungie login button",
    );
    await page.locator("#pageLanguage").selectOption("en");
    await page.waitForFunction(() => /Bungie login/.test(
      document.getElementById("bungieLoginButton")?.textContent || "",
    ));
    await page.locator("#pageLanguage").selectOption("zh-cht");
    await page.waitForFunction(() => /Bungie 登入/.test(
      document.getElementById("bungieLoginButton")?.textContent || "",
    ));
    await page.locator("#pageLanguage").selectOption("zh-chs");
    await page.waitForFunction(() => /Bungie 登录/.test(
      document.getElementById("bungieLoginButton")?.textContent || "",
    ));

    await page.locator("#bungieLoginButton").click();
    await page.waitForLoadState("networkidle");
    assert.equal(
      authorizeRequests.length,
      1,
      "the authorize navigation must be captured exactly once",
    );
    const authorize = new URL(authorizeRequests[0]);
    assert.equal(authorize.origin, "https://www.bungie.net");
    assert.equal(authorize.pathname, "/en/oauth/authorize");
    assert.equal(authorize.searchParams.get("response_type"), "code");
    assert.equal(authorize.searchParams.get("client_id"), "mock-client-id-123");
    assert.ok(authorize.searchParams.get("state"), "authorize URL must carry a state");
    assert.equal(
      authorize.searchParams.has("scope"),
      false,
      "Bungie rejects a scope parameter; none may be sent",
    );
    assert.equal(
      authorize.searchParams.has("redirect_uri"),
      false,
      "redirect_uri is not registered in the Bungie app; none may be sent",
    );
    const state = await page.evaluate(() => sessionStorage.getItem("bungieOAuthState"));
    assert.equal(
      authorize.searchParams.get("state"),
      state,
      "the callback state must be persisted before navigating away",
    );

    // --- (c) mocked OAuth callback: code+state -> token -> memberships ---
    await page.goto(baseUrl + `?code=mock-auth-code&state=${encodeURIComponent(state)}`, {
      waitUntil: "networkidle",
    });
    await page.locator(".bungie-auth-name").waitFor();
    assert.equal(
      await page.locator(".bungie-auth-name").innerText(),
      "MockGuardian",
      "the signed-in state should render the Bungie display name",
    );
    const savedToken = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("d2_armor_bungie_token_v1")));
    assert.equal(savedToken.accessToken, "mock-access");
    assert.equal(savedToken.refreshToken, "mock-refresh");
    assert.equal(new URL(page.url()).search, "", "code/state must be stripped from the URL");
    assert.equal(
      await page.evaluate(() => sessionStorage.getItem("bungieOAuthState")),
      null,
      "the consumed OAuth state must be cleared",
    );
    assert.equal(await page.locator("#bungieLoginButton").count(), 0);

    // --- (d) refresh inventory from the mocked GetProfile fixture ---
    await page.locator('#bungieAuthArea button[onclick="importInventoryFromBungie()"]').click();
    await page.waitForFunction(() => /已导入 [1-9]\d* 件 Bungie 护甲/.test(
      document.getElementById("upgradeImportSummary")?.textContent || "",
    ));
    const importMessage = await page.locator("#upgradeImportSummary").innerText();
    assert.match(importMessage, /已导入 \d+ 件 Bungie 护甲/);
    assert.match(importMessage, /请选择职业/);
    assert.match(await page.locator(".upgrade-import-state").innerText(), /已导入 \d+ 件/);
    assert.equal(await page.locator("#upgradeImportBody").isVisible(), true);

    // --- (e) error paths keep the user signed in and render classified copy ---
    for (const [mode, expectedText] of [
      ["throttle", "请求限流"],
      ["403", "API key 无效"],
      ["network", "网络错误或 CORS"],
    ]) {
      profileMode = mode;
      await page.locator('#bungieAuthArea button[onclick="importInventoryFromBungie()"]').click();
      await page.waitForFunction(text => (
        document.getElementById("upgradeImportSummary")?.textContent || ""
      ).includes(text), expectedText);
      const message = await page.locator("#upgradeImportSummary").innerText();
      assert.ok(
        message.includes(expectedText),
        `expected ${mode} error copy, got: ${message}`,
      );
      if (mode === "throttle") {
        assert.match(message, /秒后重试/, "throttle copy should name the retry window");
      }
      assert.equal(
        await page.locator(".bungie-auth-name").innerText(),
        "MockGuardian",
        "an import failure must not sign the user out",
      );
    }
    profileMode = "ok";

    // --- (f) sign out clears token, display name, and Bungie-sourced inventory ---
    await page.locator('#bungieAuthArea button[onclick="bungieLogout()"]').click();
    assert.equal(
      await page.evaluate(() => localStorage.getItem("d2_armor_bungie_token_v1")),
      null,
      "sign out must clear the stored token",
    );
    assert.equal(
      await page.evaluate(() => localStorage.getItem("d2_armor_bungie_display_name_v1")),
      null,
      "sign out must clear the cached display name",
    );
    assert.equal(await page.locator("#bungieLoginButton").count(), 1);
    assert.match(await page.locator(".upgrade-import-state").innerText(), /未导入/);
    assert.equal(await page.locator("#inventoryResults").isHidden(), true);

    // --- escape accounting: every bungie.net request must have been routed ---
    assert.equal(
      routeStats.unhandled,
      0,
      "unmocked bungie.net requests escaped: " + JSON.stringify(routeStats),
    );
    assert.deepEqual(
      observedBungieRequests.sort(),
      handledBungieRequests.sort(),
      "every observed bungie.net request must be routed by the mock interceptor",
    );
    assert.ok(
      routeStats.handled >= 9,
      "the mocked flow should exercise authorize/token/memberships/profile exchanges: " +
        JSON.stringify(routeStats),
    );
    // The 403/aborted-network console noise is the deliberate error-path
    // mock output (already asserted via the classified copy above).
    const unexpectedErrors = browserErrors.filter(error =>
      !error.includes("the server responded with a status of 403") &&
      !error.includes("net::ERR_FAILED"),
    );
    assert.deepEqual(unexpectedErrors, []);
    console.log(
      "bungie smoke: handled=" + routeStats.handled +
        " unhandled=" + routeStats.unhandled +
        " authorize=" + authorizeRequests.length,
    );
  } finally {
    await context.close();
  }
}

// Phase 1: secret-less build (login hidden) plus all existing regressions.
const envWithoutBungie = { ...process.env };
delete envWithoutBungie.BUNGIE_OAUTH_CLIENT_ID;
delete envWithoutBungie.BUNGIE_OAUTH_CLIENT_SECRET;
delete envWithoutBungie.BUNGIE_API_KEY;
runBuild(envWithoutBungie);
await startPreview();

let browser;
try {
  browser = await chromium.launch({
    executablePath: await findChrome(),
    headless: true,
  });
  await checkInventoryPlanning(browser);
  await checkUpgradeTargetSync(browser);
  await checkSetRequirementSnapshot(browser);
  await checkBungieLoginHidden(browser);
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

// Phase 2: rebuild with fake Bungie secrets and exercise the login/import
// shell against fully mocked bungie.net routes.
runBuild({
  ...envWithoutBungie,
  BUNGIE_OAUTH_CLIENT_ID: "mock-client-id-123",
  BUNGIE_OAUTH_CLIENT_SECRET: "mock-client-secret",
  BUNGIE_API_KEY: "mock-api-key",
});
await startPreview();
try {
  browser = await chromium.launch({
    executablePath: await findChrome(),
    headless: true,
  });
  await checkBungieAuthFlow(browser);
  console.log("browser smoke OK (Bungie OAuth login/import/logout, 0 escaped bungie.net requests)");
} finally {
  await browser?.close();
  await server.close();
}
