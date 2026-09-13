import assert from "node:assert/strict";
import { access, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";

import { chromium } from "playwright-core";
import { build, preview } from "vite";
import { composePages } from './compose-pages.mjs';
import {
  BALANCED_TUNING_MOD_HASH,
  STAT_MOD_HASHES,
  TUNING_MOD_HASH_BY_TUNING,
} from "../src/core/armor-mods.data.mjs";
import { channelStorageKey } from "../src/core/build-channel.mjs";
import { BASE_CONFIGS, STATS } from "../src/core/armor-model.mjs";
import { normalizeDimItem } from "../src/core/dim-csv.mjs";
import { rebuildReference } from "../tests/helpers/reference-witness.mjs";
import { GUIDE_CONTENT } from "../src/guide-content.mjs";

// The reported DIM CSV fixture, normalized through the production importer so
// the browser regression exercises the same item shape the app really sees.
const DIM_FIXTURE = JSON.parse(
  readFileSync(new URL("../tests/fixtures/dim-mask-of-fealty.json", import.meta.url), "utf8"),
);
const DIM_ITEMS = DIM_FIXTURE.records.map(normalizeDimItem);

async function checkWitnessDomRoundTrip(page) {
  const models = await page.locator('.witness-breakdown').evaluateAll(elements => elements.map(element => {
    const rows = [...element.querySelectorAll('.witness-piece')];
    const values = selector => Object.fromEntries([...element.querySelectorAll(selector)].map(span => [span.dataset.totalStat || span.dataset.fragmentStat, Number(span.dataset.value)]));
    return {pieces: rows.map(row => ({archetype: row.dataset.archetype, tertiary: row.dataset.tertiary,
      baseStats: Object.fromEntries([...row.querySelectorAll('[data-base-stat]')].map(span => [span.dataset.baseStat, Number(span.dataset.value)]))})),
      tuning: rows.map(row => JSON.parse(row.dataset.tuning)), mods: rows.map(row => JSON.parse(row.dataset.mod)),
      fragments: values('[data-fragment-stat]'), visible: values('[data-total-stat]')};
  }));
  assert.ok(models.length > 0, 'the UI must expose concrete verification rows');
  for (const model of models) {
    assert.equal(model.pieces.length, 5);
    assert.deepEqual(rebuildReference(model.pieces, model.tuning, model.mods, model.fragments).visible, model.visible);
  }
}

// Owned armor and theoretical skeletons now share one list ("配装方案") and one
// five-piece armor table. Ownership is read from the row's own projection
// attribute, so a farm row can never be miscounted just because a set badge
// happens to share its name cell.
const FARM_PLACEHOLDERS = ["Farm", "待刷取", "待取得"];

async function countUnifiedOwnedRows(page, slotLabel = null) {
  return page.evaluate(({ slot, placeholders }) => {
    const farm = new Set(placeholders);
    const rows = [...document.querySelectorAll("#inventoryResults .inventory-result-piece")];
    return rows.filter(row => {
      const slotText = (row.querySelector(".inventory-result-piece-slot")?.textContent || "").trim();
      if (slot && slotText !== slot) return false;
      const ownership = row.dataset.ownership;
      if (ownership) return ownership === "owned";
      const nameText = (row.querySelector(".inventory-result-piece-name")?.textContent || "").trim();
      return nameText !== "" && !farm.has(nameText);
    }).length;
  }, { slot: slotLabel, placeholders: FARM_PLACEHOLDERS });
}

// Reads the selected loadout's five rows in rendered order. `assignmentIndex`
// is the Solver's own config index, which is what must line up with
// tuningAssignments / modAssignments — never the row's display position.
// The six main bars and the top target strip must be read back as numbers so a
// test can compare them with the Solver's own arithmetic instead of with a
// hard-coded expectation. `.is-met` is a separate field on purpose: the failure
// mode this guards against is "bar shows 10 while the certificate says 20, and
// both claim 达标".
async function readStatBars(page) {
  return page.locator("#loadoutDetail .inventory-result-stats .inventory-result-stat").evaluateAll(elements =>
    elements.map(element => {
      const strong = (element.querySelector("strong")?.textContent || "").trim();
      const [actual, target] = strong.split("/").map(part => Number(String(part).replace(/\D/g, "")));
      return {
        actual: Number.isFinite(actual) ? actual : null,
        target: Number.isFinite(target) ? target : null,
        met: element.classList.contains("is-met"),
        required: element.classList.contains("is-required"),
        short: (element.querySelector("small")?.textContent || "").trim(),
      };
    }));
}

async function readComparisonGrid(page) {
  return page.locator("#comparisonGrid .comp-item").evaluateAll(elements =>
    elements.map(element => {
      const values = (element.querySelector(".stat-values")?.textContent || "").trim();
      const [actual, target] = values.split("/").map(part => Number(String(part).replace(/\D/g, "")));
      return {
        actual: Number.isFinite(actual) ? actual : null,
        target: Number.isFinite(target) ? target : null,
        diff: (element.querySelector(".diff")?.textContent || "").trim(),
      };
    }));
}

// The selected entry's own account of itself: what the certificate proved, and
// which execution state the preflight reached.
async function readSelectedAudit(page) {
  return page.evaluate(() => {
    const witness = window.getSelectedUnifiedWitness();
    const certificate = witness?.certificate || {};
    return {
      status: certificate.status || null,
      executionStatus: certificate.executionStatus || null,
      witnessExecutionStatus: witness?.executionStatus || null,
      statResults: certificate.statResults || {},
      visibleTotals: witness?.visibleTotals || null,
      finalTotals: witness?.finalTotals || null,
      armorTotals: witness?.armorTotals || null,
      projectedTotals: witness?.execution?.projectedTotals || null,
      actualTotals: witness?.execution?.actualTotals || null,
      unassignedMods: witness?.execution?.unassignedMods || [],
      unverifiedMods: witness?.execution?.unverifiedMods || [],
    };
  });
}

async function readLoadoutRows(page) {
  return page.locator("#loadoutDetail .inventory-result-piece").evaluateAll(elements => elements.map(row => ({
    slot: row.dataset.pieceSlot,
    assignmentIndex: Number(row.dataset.assignmentIndex),
    ownership: row.dataset.ownership,
    slotLabel: (row.querySelector(".inventory-result-piece-slot")?.textContent || "").trim(),
    archetype: (row.querySelector(".armor-archetype")?.textContent || "").trim(),
    tertiary: (row.querySelector(".armor-tertiary")?.textContent || "").trim(),
    tuning: (row.querySelector(".armor-tuning")?.textContent || "").trim(),
    mod: (row.querySelector(".armor-mod")?.textContent || "").trim(),
    state: (row.querySelector(".armor-state-cell")?.textContent || "").trim(),
  })));
}

// The set requirement, the fixed-Exotic picker and the 2pc/4pc bonus prose all
// live behind 高级约束 now, so a test that touches those controls has to open
// the disclosure first — exactly like a reader. Both helpers are idempotent and
// tolerate the element being absent.
async function openAdvancedConstraints(page) {
  const details = page.locator("#advancedConstraints");
  if (await details.count() === 0) return;
  if (await details.getAttribute("open") === null) {
    await page.locator("#advancedConstraints > summary").click();
    await page.locator("#advancedConstraints[open]").waitFor();
  }
}

async function openSetEffects(page) {
  await openAdvancedConstraints(page);
  const details = page.locator(".set-effects-toggle");
  if (await details.count() === 0) return;
  if (await details.first().getAttribute("open") === null) {
    await page.locator(".set-effects-toggle > summary").first().click();
  }
}

async function findChrome() {  const candidates = [
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
const isDevelopmentBuild = process.env.BUILD_CHANNEL === "develop";
const testChannel = isDevelopmentBuild ? "develop" : "stable";
const TEST_STORAGE_KEYS = Object.freeze({
  upgradeDraft: channelStorageKey("d2_armor_upgrade_draft_v1", testChannel),
  calculatorMode: channelStorageKey("d2_armor_calculator_mode_v1", testChannel),
  currentDraft: channelStorageKey("d2_armor_current_draft_v1", testChannel),
  token: channelStorageKey("d2_armor_bungie_token_v1", testChannel),
  displayName: channelStorageKey("d2_armor_bungie_display_name_v1", testChannel),
  oauthState: channelStorageKey("bungieOAuthState", testChannel),
});

// Bungie GetProfile fixture, already shaped as { ErrorCode: 1, Response: ... }.
const syntheticProfileFixture = JSON.parse(
  readFileSync(
    path.join(projectRoot, "tests", "fixtures", "synthetic-profile-fixture.json"),
    "utf8",
  ),
);

function createWritableProfileFixture() {  const fixture = structuredClone(syntheticProfileFixture);
  const data = fixture.Response.data;
  const hunterId = "2305843009471208001";
  const subclassId = "1000000000000000999";
  const removedHunterIds = new Set([
    "1000000000000000001",
    "1000000000000000002",
    "1000000000000000004",
  ]);
  const armor = [
    ["helmet", 30472172, 3448274439],
    ["arms", 12440395, 3551918588],
    ["chest", 24598504, 14239492],
    ["legs", 4966745, 20886954],
    ["classItem", 18990920, 1585787867],
  ].map(([slot, itemHash, bucketHash], index) => ({
    slot,
    itemHash,
    bucketHash,
    itemInstanceId: `10000000000000009${index + 1}`,
  }));
  const equippedArmor = armor.map((item, index) => ({
    ...item,
    itemInstanceId: `10000000000000008${index + 1}`,
  }));
  const currentTuningHash = TUNING_MOD_HASH_BY_TUNING["health:weapons"];
  const allArmorPlugHashes = [
    ...Object.values(STAT_MOD_HASHES).flatMap(Object.values),
    ...Object.values(TUNING_MOD_HASH_BY_TUNING),
    BALANCED_TUNING_MOD_HASH,
  ];
  data.characters.data[hunterId].stats = {
    392767087: 61,
    4244567218: 72,
    1735777505: 83,
    144602215: 94,
    1943323491: 105,
    2996146975: 116,
  };
  data.itemComponents.stats = { data: {} };

  data.profileInventory.data.items = data.profileInventory.data.items
    .filter(item => !removedHunterIds.has(String(item.itemInstanceId)))
    .concat(armor.map(item => ({
      itemHash: item.itemHash,
      itemInstanceId: item.itemInstanceId,
      quantity: 1,
      bindings: 0,
      location: 0,
      transferStatus: 1,
      lockable: true,
      state: 0,
      bucketHash: item.bucketHash,
    })));
  data.characterEquipment.data[hunterId].items = [
    {
      itemHash: 777000001,
      itemInstanceId: subclassId,
      quantity: 1,
      bucketHash: 3284755031,
    },
    ...equippedArmor.map(item => ({
      itemHash: item.itemHash,
      itemInstanceId: item.itemInstanceId,
      quantity: 1,
      bucketHash: item.bucketHash,
    })),
  ];
  for (const item of [...armor, ...equippedArmor]) {
    data.itemComponents.instances.data[item.itemInstanceId] = {
      itemLevel: 1,
      quality: 0,
      isEquipped: false,
      canEquip: true,
      energy: {
        energyCapacity: 10,
        energyUsed: 0,
        energyUnused: 10,
        energyType: 0,
        energyTypeHash: 0,
      },
      primaryStat: { statHash: 1935470627, value: 2020 },
    };
    data.itemComponents.stats.data[item.itemInstanceId] = {
      stats: {
        // Fully computed ItemStats (Bungie's contract): rolled base (health
        // 30 / grenade 25 / melee 20, super/class/weapons 5) + masterwork +5
        // to the three non-framework stats + installed health+10 mod + the
        // health:weapons tuning (+5 health, -5 weapons).
        392767087: { statHash: 392767087, value: 45 },  // health
        1735777505: { statHash: 1735777505, value: 25 }, // grenade
        4244567218: { statHash: 4244567218, value: 20 }, // melee
        144602215: { statHash: 144602215, value: 10 },   // super
        1943323491: { statHash: 1943323491, value: 10 }, // class
        // Make the vault roll strictly better for the test's Weapons target;
        // deterministic identity ties must not be used to force vault transfers.
        2996146975: { statHash: 2996146975, value: equippedArmor.includes(item) ? 0 : 5 },
      },
    };
    data.itemComponents.sockets.data[item.itemInstanceId] = {
      sockets: [
        { plugHash: STAT_MOD_HASHES.health[10], isEnabled: true, isVisible: true },
        { plugHash: currentTuningHash, isEnabled: true, isVisible: true },
      ],
    };
    // Keep the exact socket snapshot different from the normalized current
    // modifiers so the browser flow deterministically exercises socket writes.
    data.itemComponents.plugStates.data[item.itemInstanceId] = {
      plugs: [
        { plugHash: STAT_MOD_HASHES.weapons[10] },
        { plugHash: BALANCED_TUNING_MOD_HASH },
      ],
    };
  }
  // Per-instance reusable plugs (component 310): socket 0 accepts the stat
  // mods, socket 1 the tuning mods — the same contract a real armor piece has.
  data.itemComponents.reusablePlugs = { data: {} };
  for (const item of [...armor, ...equippedArmor]) {
    data.itemComponents.reusablePlugs.data[item.itemInstanceId] = {
      plugs: {
        0: Object.values(STAT_MOD_HASHES).flatMap(sizes =>
          Object.values(sizes).map(plugItemHash => ({ plugItemHash, canInsert: true, enabled: true }))),
        1: allArmorPlugHashes
          .filter(hash => !Object.values(STAT_MOD_HASHES).some(sizes => Object.values(sizes).includes(hash)))
          .map(plugItemHash => ({ plugItemHash, canInsert: true, enabled: true })),
      },
    };
  }
  data.itemComponents.sockets.data[subclassId] = {
    sockets: [{ plugHash: 777000002, isEnabled: true, isVisible: true }],
  };
  data.profilePlugSets = {
    data: {
      plugs: {
        armor: allArmorPlugHashes.map(plugItemHash => ({ plugItemHash, canInsert: true, enabled: true })),
      },
    },
  };
  data.characterPlugSets = { data: { [hunterId]: { plugs: {} } } };
  data.characterLoadouts = {
    data: {
      [hunterId]: {
        loadouts: [{
          colorHash: 1,
          iconHash: 2,
          nameHash: 3,
          items: [
            ...armor.map(item => ({
              itemInstanceId: item.itemInstanceId,
              plugItemHashes: [STAT_MOD_HASHES.health[10], BALANCED_TUNING_MOD_HASH],
            })),
            { itemInstanceId: subclassId, plugItemHashes: [777000002] },
          ],
        }],
      },
    },
  };
  return fixture;
}

// The GetProfile response served for the post-write verification read-back:
// the observed EquipItems/InsertSocketPlugFree requests are replayed as the
// new character state, so the executor's verify sees the writes it just made.
function postApplyProfileFixture(writeRequests, baseFixture) {
  const fixture = structuredClone(baseFixture);
  const data = fixture.Response.data;
  const target = writeRequests.equipItems[0];
  const itemIds = target.itemIds;
  const plugsByItem = {};
  for (const request of writeRequests.insertPlug) {
    const itemId = String(request.itemId);
    const socketIndex = request.plug?.socketIndex;
    if (socketIndex === undefined) continue;
    (plugsByItem[itemId] ||= {})[socketIndex] = request.plug.plugItemHash;
  }
  data.characterEquipment.data[target.characterId] = {
    items: itemIds.map((itemId, index) => ({
      itemHash: 1000 + index,
      itemInstanceId: String(itemId),
      quantity: 1,
      bucketHash: [3448274439, 3551918588, 14239492, 20886954, 1585787867][index] ?? 3448274439,
    })),
  };
  for (const itemId of itemIds) {
    const plugs = plugsByItem[String(itemId)] || {};
    const sockets = [];
    for (const [socketIndex, plugHash] of Object.entries(plugs)) {
      sockets[Number(socketIndex)] = { socketIndex: Number(socketIndex), plugHash, isEnabled: true, isVisible: true };
    }
    if (sockets.length > 0) data.itemComponents.sockets.data[String(itemId)] = { sockets };
  }
  return fixture;
}

// The Bungie secrets are injected at build time from the environment; the
// smoke test drives both states: a secret-less build (login hidden) and a
// build with fake secrets (full login/import flow, all bungie.net mocked).
function runBuild(env) {
  execSync("npm run build", { cwd: projectRoot, env, stdio: "inherit" });
}

let server;
let portalUrl;
let baseUrl;
const previewPort = Number(process.env.BROWSER_SMOKE_PORT) || 4174;

async function startPreview() {
  server = await preview({
    configFile: path.join(projectRoot, "vite.config.mjs"),
    logLevel: "silent",
    preview: {
      host: "127.0.0.1",
      port: previewPort,
      strictPort: false,
    },
  });
  const address = server.httpServer.address();
  const port = typeof address === "object" && address ? address.port : previewPort;
  portalUrl = "http://127.0.0.1:" + port + "/";
  baseUrl = portalUrl + "app/";
}

async function checkPortal(browser) {
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
    await page.goto(portalUrl, { waitUntil: "networkidle" });
    assert.equal(await page.locator(".route").count(), 2);
    assert.equal(
      new URL(await page.locator('.route--online a[href="./app/"]').getAttribute("href"), portalUrl)
        .pathname.endsWith("/app/"),
      true,
      "the online route should point to the app subpath",
    );
    assert.equal(
      new URL(
        await page.locator("[data-development-entry]").getAttribute("href"),
        portalUrl,
      ).pathname.endsWith("/dev/app/"),
      true,
      "the development entry should point to the preview subpath",
    );
    assert.equal(
      await page.locator(".route--offline .action").getAttribute("href"),
      "https://github.com/MIGO-OvO/d2-armor-solver/releases/latest/download/d2-armor-solver-windows-x64-setup.exe",
      "the primary offline route should download the Windows installer",
    );

    await page.locator("#portalLanguage").selectOption("zh-chs");
    assert.match(await page.locator('[data-i18n="capabilityTwo"]').innerText(), /护甲套装加成.*调整模组/);
    assert.equal(await page.locator('[data-i18n="statHealth"]').innerText(), "生命值");
    await page.locator("#portalLanguage").selectOption("zh-cht");
    assert.equal(await page.locator(".route--online h3").innerText(), "線上使用");
    assert.equal(await page.locator("html").getAttribute("lang"), "zh-Hant");
    assert.match(await page.locator('[data-i18n="capabilityTwo"]').innerText(), /防具套裝獎勵.*調校模組/);
    assert.equal(await page.locator('[data-i18n="statSuper"]').innerText(), "超能力");
    await page.locator("#portalLanguage").selectOption("en");
    assert.equal(await page.locator(".route--online h3").innerText(), "Use online");
    assert.match(await page.locator('[data-i18n="capabilityTwo"]').innerText(), /Tuning Mods/);
    assert.equal(
      await page.evaluate(() => localStorage.getItem("d2_armor_page_language_v1")),
      "en",
      "portal and app should share the language preference",
    );
    assert.match(await page.locator("#portalStatus").innerText(), /English/);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "networkidle" });
    const mobileLayout = await page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      contentWidth: document.documentElement.scrollWidth,
      offlineTop: Math.round(
        document.querySelector(".route--offline").getBoundingClientRect().top,
      ),
      viewportHeight: window.innerHeight,
    }));
    assert.ok(
      mobileLayout.contentWidth <= mobileLayout.viewportWidth + 1,
      "portal should not overflow at 390px: " + JSON.stringify(mobileLayout),
    );
    assert.ok(
      mobileLayout.offlineTop < mobileLayout.viewportHeight,
      "both online and offline routes should be discoverable in the 390px first view: " +
        JSON.stringify(mobileLayout),
    );
    const mobileRouteActions = await page.locator(".route .action").evaluateAll(elements =>
      elements.map(element => Math.round(element.getBoundingClientRect().height)),
    );
    assert.ok(
      mobileRouteActions.every(height => height >= 48),
      "mobile portal actions should retain a 48px touch target: " +
        JSON.stringify(mobileRouteActions),
    );
    assert.deepEqual(browserErrors, []);
    console.log("browser smoke OK (portal routes, shared language, 390px layout)");
  } finally {
    await context.close();
  }
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
      await page.locator("#developmentBuildBanner").isVisible(),
      isDevelopmentBuild,
      "only the development build should display the channel banner",
    );
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
    await page.evaluate(({storageKeys, configs}) => {
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
            const config = configs.find(c => c.archetype === archetypeId && c.tertiary === tertiary);
            if (!config) continue;
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
                baseStats: {...config.baseStats},
                effectiveBaseStats: {...config.baseStats},
                optimizationBaseStats: {...config.baseStats},
                masterworkTier: 5,
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
      inventory[0].setHash = 741162535;
      inventory[1].setHash = 741162535;
      for (let index = 0; index < 3; index++) {
        inventory.push({ ...inventory[index], id: `warlock-set-${index}`,
          classId: 'warlock', setHash: 741162535 });
      }
      localStorage.setItem(storageKeys.upgradeDraft, JSON.stringify({
        schemaVersion: 1,
        pieces: [],
        inventory,
        setRequirement: { type: "none" },
        manualLocked: [],
        importClassFilter: "hunter",
        importTier5Only: true,
        reassignModifiers: true,
      }));
      localStorage.setItem(storageKeys.calculatorMode, "solve");
    }, {storageKeys: TEST_STORAGE_KEYS, configs: BASE_CONFIGS});
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
    // The set picker lives behind 高级约束; read the option labels as text so
    // the assertion does not depend on the disclosure being painted.
    await openAdvancedConstraints(page);
    const setOption = page.locator('#setReqA option[value="741162535"]');
    assert.match(await setOption.textContent(), /owned 2$/);
    await page.locator('#importClass').selectOption('warlock');
    assert.match(await setOption.textContent(), /owned 3$/);
    await page.locator('#importClass').selectOption('');
    assert.doesNotMatch(await setOption.textContent(), /owned/);
    await page.locator('#importClass').selectOption('hunter');
    await page.locator('#inventoryExoticSlotFilter').selectOption('chest');
    await page.locator('#inventoryFixedExoticName').selectOption('any-exotic');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('#inventoryFixedExoticName').inputValue(), 'any-exotic',
      'an unowned reservation must survive draft restore');
    // The disclosure state lives in memory, so a reload starts collapsed again.
    await openAdvancedConstraints(page);
    await page.evaluate(() => window.solve());
    await page.locator('#inventoryResults').waitFor({ state: 'visible' });
    // Reserving the chest slot for an unowned Exotic must keep owned Legendary
    // chests out of every plan, so no entry may list an owned chest piece.
    assert.equal(
      await countUnifiedOwnedRows(page, 'Chest'),
      0,
      'an unowned Exotic reservation must exclude owned chests from the plan list',
    );
    assert.match(await page.locator('.acquisition-row', { hasText: 'Any Exotic' }).innerText(), /Chest/);
    // (5) The reserved-but-unowned Exotic must be flagged in its own armor row,
    // not only in the farm summary, and the row must read as a farm gap.
    // textContent, not innerText: the armor rows carry `content-visibility:auto`,
    // so an off-screen row legitimately renders no innerText.
    const reservedChestRow = page.locator('.inventory-result-piece[data-piece-slot="chest"]').first();
    assert.equal(
      await page.locator('.inventory-result-piece.is-farm .inventory-fixed-badge').count() >= 1,
      true,
      "an unowned Exotic requirement must be marked on the farm gap row",
    );
    assert.match(await reservedChestRow.textContent(), /Farm|待刷|待取得/);
    assert.match(await reservedChestRow.textContent(), /Exotic|异域|異域/);
    await page.locator('#inventoryFixedExoticName').selectOption('');
    assert.ok(
      await countUnifiedOwnedRows(page, 'Chest') > 0,
      'clearing the reservation permits Legendary chest matches again',
    );
    await page.locator("#inventoryExoticSlotFilter").selectOption("helmet");
    const fixedExoticValue = await page.locator("#inventoryFixedExoticName option", { hasText: "Regression Exotic" }).getAttribute("value");
    assert.ok(fixedExoticValue, "imported Exotic should be available by name");
    await page.locator("#inventoryFixedExoticName").selectOption(fixedExoticValue);
    await page.evaluate(() => window.solve());
    await page.locator("#ownedGearSection").waitFor({ state: "visible" });
    await checkWitnessDomRoundTrip(page);
    // Solver V3 proof semantics must stay reachable, but they are diagnostics
    // now: the global state is on the command bar, the per-plan proof is in the
    // advanced panel's data attribute (readable while collapsed).
    const proofSurfaces = [
      await page.locator("#searchStatus").innerText(),
      await page.locator(".loadout-status").first().innerText(),
      ...(await page.locator("#inventoryResults [data-proof-label]").evaluateAll(
        elements => elements.map(element => element.dataset.proofLabel || ""),
      )),
    ].join(" | ");
    assert.match(
      proofSurfaces,
      /(proven|Search limited|current-best witness|已证明|已證明|搜索上限)/i,
      "Worker results should expose Solver V3 proof semantics in the UI: " + proofSurfaces,
    );
    assert.equal(
      await page.locator(".inventory-results-title").first().innerText(),
      "Loadouts",
      "the plan browser should describe itself as the loadout list",
    );
    assert.match(
      await page.locator(".inventory-result-detail .acquisition-count").innerText(),
      /to farm/,
      "the selected loadout should retain a per-slot missing-armor summary",
    );
    assert.ok(
      await page.locator(".inventory-result-detail .acquisition-row").count() > 0,
      "missing armor should be listed per slot",
    );
    // Advanced diagnostics are collapsed by default; expand them to read the
    // allocation contract.
    await page.locator('#inventoryResults details[data-disclosure-key="advanced"] > summary').click();
    await page.locator('#inventoryResults details[data-disclosure-key="advanced-allocation"] > summary').click();
    assert.match(
      await page.locator("#inventoryResults .solution-tuning-primary").innerText(),
      /Planned \+5/,
      "planned +5 tuning must not describe freely selectable Exotic tuning as a fixed roll",
    );
    assert.match(
      await page.locator("#inventoryResults .solution-tuning-secondary").innerText(),
      /Suggested -5/,
      "freely selected -5 tuning should be visually secondary",
    );
    assert.equal(
      await page.locator("#inventoryPlanResults").count(),
      0,
      "scratch mode should not render a second inventory-plan list",
    );
    assert.ok(
      (await countUnifiedOwnedRows(page)) > 0,
      "the unified plan list should show armor matched from the imported inventory",
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
    await page.evaluate(storageKeys => {
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
      localStorage.setItem(storageKeys.upgradeDraft, JSON.stringify({
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
      localStorage.setItem(storageKeys.calculatorMode, "upgrade");
    }, TEST_STORAGE_KEYS);
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
    await checkWitnessDomRoundTrip(page);
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
    await openAdvancedConstraints(page);
    await page.locator("#setReqMode").selectOption("set4");
    // The set picker now lists the whole 56-set catalog, so pick the set this
    // fixture actually owns instead of relying on the first option.
    await page.locator("#setReqA").selectOption("741162535");
    await page.evaluate(() => window.analyzeArmorUpgrades());
    assert.equal(
      await page.locator("#upgradeResults").isHidden(),
      false,
      "the stat-only replacement plan must stay visible under a set requirement",
    );
    assert.equal(
      await page.locator(".inventory-results-title").innerText(),
      "已有护甲搭配方案",
    );
    assert.ok(
      await page.locator("#inventoryResults .inventory-result-stat.is-required").count() >= 1,
      "set-constrained owned loadouts should keep must-meet stats visible",
    );
    assert.deepEqual(browserErrors, []);
  } finally {
    await context.close();
  }
}

// A cancelled solver call is superseded work, not a failure. `#inputCard`'s
// input listener stops every in-flight operation and re-probes 180ms later, so
// editing a target while the realtime reachability probe is running rejects that
// probe with an AbortError. The probe used to be the one call site that reported
// that cancellation as "Reachability calculation failed", which the
// mocked-Bungie phase caught as an unexpected console error. Holding the probe's
// postMessage keeps the request pending, so the cancellation is deterministic
// instead of a race only a slow runner hits.
async function checkCancelledReachabilityProbe(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      const original = Worker.prototype.postMessage;
      window.__probeHold = {
        started: 0,
        restore: () => { Worker.prototype.postMessage = original; },
      };
      // Only the reachability probe is held: every other worker message (the
      // seconds-long searches) must pass through untouched.
      Worker.prototype.postMessage = function (message, ...rest) {
        if (message?.operation === "calculateReachability") {
          window.__probeHold.started += 1;
          return undefined;
        }
        return original.call(this, message, ...rest);
      };
    });
    await page.locator("#inputCard input[id^='target_']").first().evaluate(input => {
      input.value = String(Number(input.value || 0) + 1);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The realtime range probe only runs while an Exotic framework is selected.
    await page.locator("#useExoticMode").check();
    await page.waitForFunction(() => window.__probeHold.started > 0, null, { timeout: 15000 });
    await page.evaluate(() => window.__probeHold.restore());
    await page.evaluate(() => window.stopSearches());
    // Let the debounced re-probe reach the real worker and finish: neither the
    // cancellation nor the recovery may log anything.
    await page.waitForTimeout(800);
    assert.equal(
      browserErrors.filter(error => /Reachability|AbortError|Cancelled/.test(error)).length,
      0,
      "cancelling an in-flight reachability probe must not be reported as a failure: "
        + JSON.stringify(browserErrors),
    );
    assert.deepEqual(browserErrors, []);
    console.log("browser smoke: a cancelled reachability probe stays silent OK");
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
    await page.evaluate(storageKeys => {
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
      localStorage.setItem(storageKeys.upgradeDraft, JSON.stringify({
        schemaVersion: 1,
        pieces,
        inventory,
        setRequirement: { type: "none" },
        manualLocked: [],
        importClassFilter: "hunter",
        importTier5Only: true,
        reassignModifiers: true,
      }));
      localStorage.setItem(storageKeys.calculatorMode, "upgrade");
    }, TEST_STORAGE_KEYS);
    await page.reload({ waitUntil: "networkidle" });

    const staleSolve = page.evaluate(() => window.analyzeArmorUpgrades());
    await page.waitForTimeout(25);
    // The set picker lists the full catalog now; select the fixture's set.
    await openAdvancedConstraints(page);
    await page.locator("#setReqMode").selectOption("set4");
    await page.locator("#setReqA").selectOption("741162535");
    await staleSolve;
    assert.equal(
      await page.locator("#inventoryResults").isHidden(),
      true,
      "an inventory result solved under an old set requirement must be discarded",
    );

    await page.evaluate(() => window.analyzeArmorUpgrades());
    await page.locator("#inventoryResults:not([hidden])").waitFor();
    await checkWitnessDomRoundTrip(page);
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

    // Regression: choosing a second set in 2+2 (split) mode must persist. The
    // two pickers used to share one options list where both sets were marked
    // "selected", so the browser showed the first-selected set in both selects
    // and every re-render silently reset the second set.
    const setValues = await page
      .locator("#setReqA option")
      .evaluateAll(options => options.map(option => option.value));
    assert.ok(setValues.length >= 2, "expected at least two sets in the picker");
    const [firstSet, secondSet] = setValues;
    await page.locator("#setReqMode").selectOption("split");
    await page.locator("#setReqA").selectOption(firstSet);
    await page.locator("#setReqB").selectOption(secondSet);
    assert.equal(
      await page.locator("#setReqA").inputValue(),
      firstSet,
      "the first 2+2 set must keep its value",
    );
    assert.equal(
      await page.locator("#setReqB").inputValue(),
      secondSet,
      "the second 2+2 set must keep the value the user picked",
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
      await page.locator("#headerBungieAuth").innerText(),
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
  const writeRequests = {
    equipLoadout: [],
    transfer: [],
    equipItems: [],
    insertPlug: [],
  };
  const writableProfileFixture = createWritableProfileFixture();
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
    if (url.pathname.endsWith("/User/GetMembershipsForCurrentUser/")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: membershipsBody,
      });
    }
    const writeRoute = {
      "/Platform/Destiny2/Actions/Loadouts/EquipLoadout/": "equipLoadout",
      "/Platform/Destiny2/Actions/Items/TransferItem/": "transfer",
      "/Platform/Destiny2/Actions/Items/EquipItems/": "equipItems",
      "/Platform/Destiny2/Actions/Items/InsertSocketPlugFree/": "insertPlug",
    }[url.pathname];
    if (writeRoute) {
      assert.equal(route.request().method(), "POST", `${writeRoute} must use POST`);
      const requestBody = route.request().postDataJSON();
      writeRequests[writeRoute].push(requestBody);
      const response = writeRoute === "equipItems"
        ? {
            equipResults: requestBody.itemIds.map(itemInstanceId => ({
              itemInstanceId,
              equipStatus: 1,
            })),
          }
        : 0;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ErrorCode: 1, Response: response }),
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
      // After a custom apply, the verify re-read must reflect the writes: the
      // plan's instances equipped with the inserted plugs (otherwise the
      // verification read-back would always report mismatches).
      if (writeRequests.equipItems.length > 0) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(postApplyProfileFixture(writeRequests, writableProfileFixture)),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(writableProfileFixture),
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
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileLoginLayout = await page.locator("#bungieLoginButton").evaluate(element => {
      const header = document.querySelector(".header").getBoundingClientRect();
      return {
        loginWidth: element.getBoundingClientRect().width,
        headerWidth: header.width,
      };
    });
    assert.ok(
      mobileLoginLayout.loginWidth >= mobileLoginLayout.headerWidth - 4,
      "mobile logged-out Bungie action should span the auth row: " +
        JSON.stringify(mobileLoginLayout),
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
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

    // Official Armor 3.0 terminology must render from the same contract in
    // every application locale, including dynamic Archetype controls.
    await page.evaluate(() => window.setCalculatorMode("upgrade"));
    // Piece editors are collapsed by default; open the first one to read its
    // Archetype control and Tuning Mod label. The open row survives the
    // language switch because the renderer reads the disclosure state back
    // from the DOM.
    await page.locator("#upgradeBuildEditor .upgrade-piece-row summary").first().click();
    for (const [language, skirmisher, tuningMod] of [
      ["zh-chs", "突击手", "调整模组"],
      ["zh-cht", "散兵", "調校模組"],
      ["en", "Skirmisher", "Tuning Mod"],
    ]) {
      await page.locator("#pageLanguage").selectOption(language);
      assert.equal(
        await page.locator('#upgradeBuildEditor select option[value="Skirmisher"]').first().innerText(),
        skirmisher,
        `${language} should render the official Skirmisher name`,
      );
      assert.equal(
        await page.locator("#upgradeBuildEditor .input-group > span", { hasText: tuningMod }).first().innerText(),
        tuningMod,
        `${language} should render the official Tuning Mod term`,
      );
    }
    await page.locator("#pageLanguage").selectOption("zh-chs");
    await page.evaluate(() => window.setCalculatorMode("solve"));

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
    const state = await page.evaluate(
      key => sessionStorage.getItem(key),
      TEST_STORAGE_KEYS.oauthState,
    );
    assert.equal(
      authorize.searchParams.get("state"),
      state,
      "the callback state must be persisted before navigating away",
    );
    assert.equal(
      state.startsWith(`${testChannel}.`),
      true,
      "OAuth state must identify the build channel for callback routing",
    );

    // --- (c) mocked OAuth callback: code+state -> token -> memberships ---
    await page.goto(baseUrl + `?code=mock-auth-code&state=${encodeURIComponent(state)}`, {
      waitUntil: "networkidle",
    });
    await page.locator(".bungie-account-copy strong").waitFor();
    assert.equal(
      await page.locator(".bungie-account-copy strong").innerText(),
      "MockGuardian",
      "the signed-in state should render the Bungie display name",
    );
    const savedToken = await page.evaluate(
      key => JSON.parse(localStorage.getItem(key)),
      TEST_STORAGE_KEYS.token,
    );
    assert.equal(savedToken.accessToken, "mock-access");
    assert.equal(savedToken.refreshToken, "mock-refresh");
    assert.equal(new URL(page.url()).search, "", "code/state must be stripped from the URL");
    assert.equal(
      await page.evaluate(
        key => sessionStorage.getItem(key),
        TEST_STORAGE_KEYS.oauthState,
      ),
      null,
      "the consumed OAuth state must be cleared",
    );
    assert.equal(await page.locator("#bungieLoginButton").count(), 0);
    assert.equal(
      await page.locator('.bungie-account-popover [onclick="importInventoryFromBungie()"]').count(),
      0,
      "inventory sync should not be hidden in the account menu",
    );
    assert.equal(await page.locator(".bungie-sync-button").isVisible(), true);
    assert.match(await page.locator(".bungie-sync-meta").innerText(), /10/);
    assert.equal(
      await page.evaluate(() => window.shouldAutoRefresh(Date.now() + 10_001)),
      true,
      "a visible signed-in page should become eligible for refresh after 10 seconds",
    );
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    });
    assert.equal(
      await page.evaluate(() => window.shouldAutoRefresh(Date.now() + 10_001)),
      false,
      "a hidden page must not auto-refresh inventory",
    );
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    });

    // --- (d) refresh inventory from the mocked GetProfile fixture ---
    await page.locator('.bungie-sync-button[onclick="importInventoryFromBungie()"]').click();
    await page.waitForFunction(() => /已导入 [1-9]\d* 件 Bungie 护甲/.test(
      document.getElementById("upgradeImportSummary")?.textContent || "",
    ));
    const importMessage = await page.locator("#upgradeImportSummary").innerText();
    assert.match(importMessage, /已导入 \d+ 件 Bungie 护甲/);
    assert.match(importMessage, /请选择职业/);
    assert.match(await page.locator(".upgrade-import-state").innerText(), /已导入 \d+ 件/);
    assert.equal(await page.locator("#upgradeImportBody").isVisible(), true);

    const profileRequestUrl = observedBungieRequests.find(requestUrl =>
      /\/Destiny2\/\d+\/Profile\//.test(new URL(requestUrl).pathname)
    );
    assert.ok(profileRequestUrl, "inventory import must issue a GetProfile request");
    const requestedComponents = new Set(
      (new URL(profileRequestUrl).searchParams.get("components") || "").split(","),
    );
    assert.equal(requestedComponents.has("CharacterLoadouts"), true);
    assert.equal(requestedComponents.has("ProfilePlugSets"), false);
    assert.equal(requestedComponents.has("CharacterPlugSets"), false);
    assert.equal(
      requestedComponents.has("ItemReusablePlugs"),
      true,
      "the armor inventory import must request per-instance reusable plugs",
    );

    await page.locator("#importClass").selectOption("hunter");
    await page.evaluate(() => window.applyEquippedLoadout());
    const expectedCurrentStats = {
      health: "61",
      melee: "72",
      grenade: "83",
      super: "94",
      class: "105",
      weapons: "116",
    };
    for (const [stat, value] of Object.entries(expectedCurrentStats)) {
      assert.equal(
        await page.locator(`#target_${stat}`).inputValue(),
        value,
        `Bungie equipped-loadout target ${stat} must use the aggregate character stat`,
      );
    }

    // --- (d2) an Exotic Class Item selection survives a Bungie re-import ---
    // Regression: applyImportedInventory used to clear the Exotic selection on
    // every import, so the Bungie auto-refresh silently dropped the user's
    // fixed Exotic and solutions stopped honoring it.
    await page.locator("#useExoticMode").check();
    assert.equal(
      await page.locator("#inventoryExoticSlotFilter").inputValue(),
      "classItem",
      "enabling Exotic Class Item mode must pin the Exotic slot filter",
    );
    await page.locator('.bungie-sync-button[onclick="importInventoryFromBungie()"]').click();
    await page.waitForFunction(() => /Bungie 库存/.test(
      document.getElementById("upgradeImportSummary")?.textContent || "",
    ));
    assert.equal(
      await page.locator("#useExoticMode").isChecked(),
      true,
      "a re-import must not uncheck Exotic Class Item mode",
    );
    assert.equal(
      await page.locator("#inventoryExoticSlotFilter").inputValue(),
      "classItem",
      "a re-import must keep the Exotic Class Item slot filter",
    );
    await page.locator("#useExoticMode").uncheck();

    // --- (e) saved game loadout and custom solver result cover all write routes ---
    assert.equal(await page.locator(".bungie-saved-loadouts").count(), 1);
    await openAdvancedConstraints(page);
    await page.locator('#setReqMode').selectOption('set2');
    await page.locator('#setReqA').selectOption('741162535');
    await openSetEffects(page);
    await page.locator('.set-preview-notes > summary').click();
    await page.locator(".bungie-saved-loadouts > summary").click();
    await page.evaluate(() => window.importInventoryFromBungie({ silent: true }));
    assert.equal(await page.locator('.bungie-saved-loadouts').evaluate(el => el.open), true,
      'passive inventory refresh must preserve expanded saved loadouts');
    assert.equal(await page.locator('.set-preview-notes').evaluate(el => el.open), true,
      'passive inventory refresh must preserve expanded set notes');
    await page.locator('.set-preview-notes > summary').click();
    await page.evaluate(() => window.importInventoryFromBungie({ silent: true }));
    assert.equal(await page.locator('.set-preview-notes').evaluate(el => el.open), false,
      'passive inventory refresh must also preserve explicitly collapsed sections');
    await page.locator('#setReqA').focus();
    const focusedSelect = await page.locator('#setReqA').elementHandle();
    await page.evaluate(() => window.importInventoryFromBungie({ silent: true }));
    assert.equal(await focusedSelect.evaluate(el => el.isConnected && document.activeElement === el), true,
      'a passive refresh must not destroy the native select being used');
    await page.locator('#setReqMode').selectOption('none');
    await page.locator(".bungie-saved-actions .btn-solve").click();
    await page.waitForFunction(() => /游戏内配装已完整应用/.test(
      document.getElementById("upgradeImportSummary")?.textContent || "",
    ));
    assert.deepEqual(writeRequests.equipLoadout, [{
      loadoutIndex: 0,
      characterId: "2305843009471208001",
      membershipType: 3,
    }]);

    await page.locator(".bungie-saved-actions .btn").click();
    await page.locator('[id^="target_"]').evaluateAll(elements => {
      for (const element of elements) {
        element.value = element.id === "target_weapons" ? "200" : "0";
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await page.evaluate(() => window.analyzeArmorUpgrades());
    await page.locator("#inventoryResults:not([hidden])").waitFor();
    const equipButton = page.locator("#bungieEquipButton");
    assert.equal(
      await equipButton.isEnabled(),
      true,
      "a five-instance Bungie solution that passes preflight should be directly equippable: " +
        await page.locator(".bungie-equip-hint").innerText(),
    );
    await equipButton.click();
    await page.waitForFunction(() => /五件护甲与(?:可安装)?模组已装备|护甲与模组已装备|已装备 \d\/5 件护甲|装备到游戏失败|已完成部分/.test(
      document.getElementById("bungieEquipStatus")?.textContent || "",
    ));
    assert.equal(writeRequests.transfer.length, 5, "five vault armor pieces should transfer");
    assert.equal(writeRequests.equipItems.length, 1, "target armor should equip in one request");
    const customEquipStatus = await page.locator("#bungieEquipStatus").innerText();
    assert.ok(
      writeRequests.insertPlug.length > 0 ||
        /五件护甲与(?:可安装)?模组已装备/.test(
          customEquipStatus,
        ),
      "the custom plan must either write its sockets or explicitly report an armor-only apply: " +
        JSON.stringify({ customEquipStatus, insertPlug: writeRequests.insertPlug.length }),
    );
    assert.equal(writeRequests.equipItems[0].itemIds.length, 5);
    assert.ok(writeRequests.insertPlug.every(body => body.plug?.socketArrayType === 0));

    // --- (e2) from-scratch owned armor exposes the live Bungie target picker.
    // The single-item action sequence itself is covered at the API boundary in
    // bungie-loadout.test.mjs, where its transfer/equip requests are exact.
    await page.evaluate(() => {
      window.setCalculatorMode("solve");
      for (const stat of ["health", "melee", "grenade", "super", "class", "weapons"]) {
        const fragment = document.getElementById(`fragVal_${stat}`);
        if (fragment) {
          fragment.textContent = "0";
          fragment.style.color = "";
        }
      }
      document.getElementById("numPlus5").value = "0";
      document.getElementById("numPlus10").value = "5";
      window.resetTargetStats();
      const ownedArmorTargets = {
        health: 195,
        grenade: 145,
        melee: 110,
        super: 25,
        class: 25,
        weapons: 0,
      };
      for (const [stat, value] of Object.entries(ownedArmorTargets)) {
        const input = document.getElementById(`target_${stat}`);
        input.value = String(value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      window.solve();
    });
    await page.locator("#results.show").waitFor();
    assert.equal(await page.locator("#ownedGearSection .owned-gear-target select").count(), 1);

    // --- (f) error paths keep the user signed in and render classified copy ---
    for (const [mode, expectedText] of [
      ["throttle", "请求限流"],
      ["403", "API key 无效"],
      ["network", "网络错误或 CORS"],
    ]) {
      profileMode = mode;
      await page.locator('.bungie-sync-button[onclick="importInventoryFromBungie()"]').click();
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
        await page.locator(".bungie-account-copy strong").innerText(),
        "MockGuardian",
        "an import failure must not sign the user out",
      );
    }
    profileMode = "ok";

    // --- (g) sign out clears token, display name, and Bungie-sourced inventory ---
    page.once("dialog", dialog => dialog.accept());
    await page.locator(".bungie-account-menu > summary").click();
    await page.locator('.bungie-account-danger button[onclick="bungieLogout()"]').click();
    assert.equal(
      await page.evaluate(key => localStorage.getItem(key), TEST_STORAGE_KEYS.token),
      null,
      "sign out must clear the stored token",
    );
    assert.equal(
      await page.evaluate(key => localStorage.getItem(key), TEST_STORAGE_KEYS.displayName),
      null,
      "sign out must clear the cached display name",
    );
    assert.equal(await page.locator("#bungieLoginButton").count(), 1);
    assert.match(await page.locator(".upgrade-import-state").innerText(), /未导入/);
    // The merged plan list stays visible: theoretical skeletons do not depend on
    // an import. What must disappear is every Bungie-sourced owned piece and its
    // equip action.
    assert.equal(
      await page.locator("#inventoryResults .bungie-equip-panel").count(),
      0,
      "signing out must remove every Bungie-sourced equip action",
    );
    assert.equal(
      await countUnifiedOwnedRows(page),
      0,
      "signing out must drop the imported Bungie inventory from the plan list",
    );

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

// The result page is a two-column workspace: one command bar, one target
// summary, one plan browser, one selected loadout. These regressions pin the
// information architecture so card soup and duplicated status banners cannot
// come back, and they cover selection, filtering and diagnostics folding.
async function checkResultWorkspace(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => window.solve());
    await page.locator("#inventoryResults:not([hidden])").waitFor();

    // (12) (13) exactly one plan surface and exactly one target comparison.
    for (const legacy of ["#solutionNav", "#piecesCard", "#exoticCard", "#exoticRecommendation", "#resultsMain"]) {
      assert.equal(await page.locator(legacy).count(), 0, legacy + " must not exist any more");
    }
    assert.equal(await page.locator(".inventory-results-title").count(), 1, "one plan-browser heading");
    assert.equal(await page.locator(".inventory-result-list").count(), 1, "one plan list");
    assert.equal(await page.locator(".inventory-result-detail").count(), 1, "one selected-loadout column");
    assert.equal(await page.locator(".comparison").count(), 1, "目标 vs 实际 must appear exactly once");
    assert.equal(await page.locator("#comparisonGrid .comp-item").count(), 6);
    assert.equal(await page.locator(".inventory-result-stats").count(), 1, "the six stats appear once");
    assert.equal(
      await page.locator(".inventory-result-stats .inventory-result-stat").count(),
      6,
      "the selected loadout shows six stats",
    );

    // (9) desktop keeps a real two-column workspace.
    const layout = await page.locator(".inventory-results-layout").evaluate(element => {
      const listBox = document.getElementById("planBrowser").getBoundingClientRect();
      const detailBox = document.getElementById("loadoutDetail").getBoundingClientRect();
      return {
        columns: getComputedStyle(element).gridTemplateColumns.split(" ").length,
        listLeft: Math.round(listBox.left),
        detailLeft: Math.round(detailBox.left),
        listWidth: Math.round(listBox.width),
      };
    });
    assert.equal(layout.columns, 2, ">=1100px must render two workspace columns");
    assert.ok(layout.detailLeft > layout.listLeft, "the loadout column must sit to the right of the plan browser");
    assert.ok(layout.listWidth >= 300 && layout.listWidth <= 400,
      "the plan browser must stay clamp(300px, 26vw, 380px): " + layout.listWidth);

    // (10) diagnostics are folded by default and the constraint matrix lives in
    // the 编辑条件 drawer, not on the first screen.
    for (const key of ["advanced", "advanced-allocation"]) {
      const open = await page.locator(`#inventoryResults details[data-disclosure-key="${key}"]`)
        .first().evaluate(element => element.open);
      assert.equal(open, false, key + " must be collapsed by default");
    }
    assert.equal(await page.locator("#conditionsDrawer").isHidden(), true, "the constraint drawer starts collapsed");
    assert.equal(await page.locator("#refineCard .constraint-matrix").isVisible(), false);

    // (1) selecting a different plan swaps only the detail column.
    await page.locator("#planList").evaluate(element => { element.dataset.listMarker = "kept"; });
    // Park the workspace in view first, so the measurement isolates the app's own
    // scrolling rather than the click helper's scroll-into-view.
    await page.locator(".inventory-results-layout").scrollIntoViewIfNeeded();
    await page.waitForTimeout(50);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const listScrollBefore = await page.locator("#planList").evaluate(element => element.scrollTop);
    const firstLabel = await page.locator(".loadout-header .inventory-result-detail-label").innerText();
    await page.locator("#planList .inventory-result-option").nth(3).click();
    assert.equal(
      await page.locator('.inventory-result-option[aria-selected="true"]').getAttribute("data-plan-index"),
      "3",
      "clicking a plan row must select it",
    );
    assert.notEqual(
      await page.locator(".loadout-header .inventory-result-detail-label").innerText(),
      firstLabel,
      "switching plans must re-render the selected loadout",
    );
    assert.equal(
      await page.locator("#planList").getAttribute("data-list-marker"),
      "kept",
      "switching plans must not rebuild the plan list DOM",
    );
    assert.equal(
      await page.evaluate(() => window.scrollY),
      scrollBefore,
      "switching plans must not yank the reader back to the top of the page",
    );
    assert.equal(
      await page.locator("#planList").evaluate(element => element.scrollTop),
      listScrollBefore,
      "switching plans must keep the plan browser scroll position",
    );

    // (11) Cross-domain invariant: the six bars, their 达标 markers and the top
    // target strip must all come from the selected entry's own certificate. The
    // failure this pins down is a bar reading the *installable* subset while the
    // marker reads the mathematical certificate ("10 / 20 ✓ 达标").
    const auditedPlans = Math.min(
      await page.locator("#planList .inventory-result-option").count(),
      6,
    );
    for (let planIndex = 0; planIndex < auditedPlans; planIndex++) {
      await page.locator("#planList .inventory-result-option").nth(planIndex).click();
      const [bars, grid, audit] = await Promise.all([
        readStatBars(page),
        readComparisonGrid(page),
        readSelectedAudit(page),
      ]);
      assert.equal(bars.length, STATS.length, "the selected loadout must show six stat bars");
      assert.equal(grid.length, STATS.length, "the target strip must show six stats");
      for (const [statIndex, stat] of STATS.entries()) {
        const bar = bars[statIndex];
        const result = audit.statResults[stat];
        assert.ok(result, `plan ${planIndex} has no certificate statResult for ${stat}`);
        assert.equal(
          bar.actual,
          result.actual,
          `plan ${planIndex} ${stat}: the bar must show the certificate's arithmetic (${result.actual}), `
            + `not an execution subset — bar=${JSON.stringify(bar)} installable=${JSON.stringify(audit.actualTotals)}`,
        );
        assert.equal(
          bar.met,
          result.met === true,
          `plan ${planIndex} ${stat}: the 达标 marker must agree with the certificate`,
        );
        assert.equal(
          bar.target,
          result.target,
          `plan ${planIndex} ${stat}: the bar's target must be the solved target`,
        );
        if (audit.status === "EXACT_TARGET_PROVEN") {
          assert.equal(
            bar.actual,
            bar.target,
            `plan ${planIndex} ${stat}: an exact plan must show its exact value, never ${bar.actual}/${bar.target}`,
          );
        }
        assert.ok(
          !(bar.met && typeof result.below === "number" && result.below > 0),
          `plan ${planIndex} ${stat}: 达标 while the certificate reports a shortfall`,
        );
      }
      // The top strip is the *same* selected entry, so switching plans can never
      // leave the old plan's numbers above a new plan's detail column.
      const visible = audit.visibleTotals || audit.finalTotals || {};
      for (const [statIndex, stat] of STATS.entries()) {
        assert.equal(
          grid[statIndex].actual,
          Number(visible[stat] || 0),
          `plan ${planIndex} ${stat}: the target strip is stale relative to the selected entry`,
        );
        assert.equal(grid[statIndex].target, bars[statIndex].target, "the strip and the bars must share one target");
      }
    }
    await page.locator("#planList .inventory-result-option").nth(0).click();

    // (2) every qualifying plan outranks every non-qualifying one, and a
    // qualifying row always carries the verified wording.
    const rows = await page.locator("#planList .inventory-result-option").evaluateAll(elements =>
      elements.map(element => ({
        tone: element.querySelector(".inventory-result-state")?.className || "",
        proof: element.querySelector(".inventory-result-state")?.getAttribute("data-proof-label") || "",
        meta: element.querySelector(".inventory-result-option-meta")?.textContent || "",
      })));
    assert.ok(rows.length > 0, "the plan browser must render rows");
    const lastQualifying = rows.map(row => row.tone.includes("is-met")).lastIndexOf(true);
    const firstNonQualifying = rows.map(row => !row.tone.includes("is-met")).indexOf(true);
    assert.ok(
      firstNonQualifying === -1 || lastQualifying === -1 || firstNonQualifying > lastQualifying,
      "达标 must be the first ranking axis: " + JSON.stringify(rows.slice(0, 6)),
    );
    // (3) a plan whose stats satisfy the rules but whose owned/farm mapping
    // cannot implement them must never be presented as qualifying.
    for (const row of rows) {
      if (!row.tone.includes("is-met")) continue;
      assert.doesNotMatch(row.proof, /不可实施|不可實施|Unmappable/, "unmappable plan marked 达标: " + row.proof);
      assert.match(row.proof, /verified|已驗證|已验证/i, "qualifying rows must be verified: " + row.proof);
    }

    // (4) 达标 / 已有齐全 / 待刷 <=1 filters agree with the rows they render.
    const chipCounts = await page.locator(".plan-chip").evaluateAll(elements => elements.map(element => ({
      label: element.textContent || "",
      count: Number(element.querySelector("span")?.textContent || 0),
    })));
    assert.equal(chipCounts.length, 4, "the plan browser exposes four filters");
    const expectFiltered = async (index, predicate, description) => {
      await page.locator(".plan-chip").nth(index).click();
      if (chipCounts[index].count === 0) {
        // An emptied filter must keep the toolbar reachable so the reader can
        // switch back; hiding the whole workspace would trap them.
        assert.equal(await page.locator("#inventoryResults").isHidden(), false,
          description + " must keep the workspace and its filter toolbar visible");
        assert.equal(await page.locator("#planList .inventory-result-option").count(), 0,
          description + " must render no plan rows");
        assert.ok(await page.locator(".plan-empty").count() >= 1,
          description + " should explain that the filter matched nothing");
      } else {
        const metas = await page.locator("#planList .inventory-result-option-meta")
          .evaluateAll(elements => elements.map(element => element.textContent || ""));
        assert.ok(metas.length > 0, description + " must render its matches");
        assert.equal(metas.length, Math.min(chipCounts[index].count, 60),
          description + " must render exactly the counted plans");
        for (const meta of metas) assert.ok(predicate(meta), description + " leaked a non-matching row: " + meta);
      }
      await page.locator(".plan-chip").nth(0).click();
      await page.locator("#inventoryResults:not([hidden])").waitFor();
    };
    await expectFiltered(1, () => true, "达标");
    await expectFiltered(2, meta => /已有 5\/5|5\/5 owned/.test(meta), "已有齐全");
    await expectFiltered(3, meta => /待刷 (0|1)\b|to farm/.test(meta) && !/待刷 [2-9]/.test(meta), "待刷 ≤1");
    assert.equal(
      await page.locator(".plan-chip").evaluateAll(elements =>
        elements.findIndex(element => element.getAttribute("aria-pressed") === "true")),
      0,
      "the 全部 filter is restored after the filter round-trip",
    );

    // (4b) the farm-count sort is ascending and the owned sort is descending.
    await page.locator(".plan-sort select").selectOption("farm");
    const farmOrder = await page.locator("#planList .inventory-result-option-meta").evaluateAll(elements =>
      elements.map(element => {
        const match = /待刷\s*(\d+)/.exec(element.textContent || "");
        return match ? Number(match[1]) : 0;
      }));
    assert.deepEqual(farmOrder, [...farmOrder].sort((left, right) => left - right),
      "待刷最少 sort must be ascending");
    await page.locator(".plan-sort select").selectOption("owned");
    const ownedOrder = await page.locator("#planList .inventory-result-option-meta").evaluateAll(elements =>
      elements.map(element => {
        const match = /已有\s*(\d+)\/5/.exec(element.textContent || "");
        return match ? Number(match[1]) : 0;
      }));
    assert.deepEqual(ownedOrder, [...ownedOrder].sort((left, right) => right - left),
      "已有最多 sort must be descending");
    await page.locator(".plan-sort select").selectOption("recommended");

    // (7) a full workspace re-render (what a progressive search update does)
    // must keep the reader's plan, matched by content key rather than position.
    await page.locator("#planList .inventory-result-option").nth(5).click();
    const keptKey = await page.locator('.inventory-result-option[aria-selected="true"]').getAttribute("data-plan-key");
    await page.locator(".plan-sort select").selectOption("farm");
    await page.locator(".plan-sort select").selectOption("recommended");
    assert.equal(
      await page.locator('.inventory-result-option[aria-selected="true"]').getAttribute("data-plan-key"),
      keptKey,
      "a re-render must keep the selected plan",
    );

    // (11) the command bar and the loadout header agree about exportability, and
    // the export path addresses the plan that is actually selected.
    const exportState = await page.evaluate(() => ({
      command: document.getElementById("cmdExportDim").disabled,
      detail: document.querySelector(".inventory-export-button").disabled,
      commandTitle: document.getElementById("cmdExportDim").title,
    }));
    assert.equal(exportState.command, exportState.detail,
      "the command bar and the loadout header must agree about exportability");
    if (exportState.command) {
      assert.match(exportState.commandTitle, /还需刷取|still needs/,
        "a disabled export action must explain what is missing");
    }
    const selectedOption = page.locator('.inventory-result-option[aria-selected="true"]');
    const selectedIndex = Number(await selectedOption.getAttribute("data-plan-index"));
    const selectedFarmCount = Number(
      /待刷\s*(\d+)/.exec(await selectedOption.locator(".inventory-result-option-meta").innerText())?.[1] ?? 0,
    );
    await page.evaluate(index => window.exportInventorySolution(index), selectedIndex);
    const exportMessage = await page.locator("#messages").innerText();
    if (selectedFarmCount > 0) {
      assert.match(
        exportMessage,
        new RegExp("还需刷取 " + selectedFarmCount + " 件"),
        "exporting must describe the selected plan's own farm gap: " + exportMessage,
      );
    } else {
      assert.match(exportMessage, /DIM/, "a fully owned plan must produce a DIM link message");
    }

    // (14) the inventory manager stays reachable, just folded away.
    await page.locator("#manualOwnedManageButton").click();
    assert.equal(await page.locator("#manualOwnedEditor").evaluate(element => element.open), true,
      "the 管理 button must open the manual armor editor");
    await page.locator("#addManualOwnedButton").click();
    assert.ok(
      await page.locator("#ownedGearSection .manual-owned-list li").count() > 0,
      "the manual armor editor must still register armor",
    );

    // (15) stopping the search keeps every verified result on screen.
    await page.locator("#searchProfile").selectOption("deep");
    await page.evaluate(() => { window.__stoppedSearch = window.solve(); });
    await page.locator("#inventoryResults:not([hidden])").waitFor({ timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById("cancelSearch").disabled);
    const rowsBeforeStop = await page.locator("#planList .inventory-result-option").count();
    const statsBeforeStop = await page.locator(".inventory-result-stats .inventory-result-stat").count();
    await page.locator("#cancelSearch").click();
    await page.evaluate(() => window.__stoppedSearch);
    assert.match(await page.locator("#searchStatus").innerText(), /停止|stopped/);
    assert.equal(await page.locator("#inventoryResults").isHidden(), false,
      "stopping the search must keep the verified plan list");
    assert.ok(rowsBeforeStop > 0, "the partial result should already expose verified plans");
    assert.equal(await page.locator("#planList .inventory-result-option").count(), rowsBeforeStop,
      "stopping the search must not drop retained plan rows");
    assert.equal(statsBeforeStop, 6, "the selected loadout shows its six stats");
    await page.locator("#searchProfile").selectOption("balanced");

    assert.deepEqual(browserErrors, []);
    console.log("browser smoke: result workspace IA/selection/filter regressions OK");
  } finally {
    await context.close();
  }
}

const CANONICAL_SLOT_ORDER = ["helmet", "arms", "chest", "legs", "classItem"];

function sumArchetypeTally(text) {
  return [...String(text || "").matchAll(/×\s*(\d+)/g)]
    .reduce((total, match) => total + Number(match[1]), 0);
}

// The selected loadout's presentation contract: one canonical slot order, an
// assignment index that still addresses the Solver's own Tuning/mod arrays, the
// planned armour mods of farm pieces, and an acquisition plan whose tallies only
// ever count what is actually missing.
async function checkLoadoutPresentation(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => window.solve());
    await page.locator("#inventoryResults:not([hidden])").waitFor();

    // (1) (2) Slot order is a display projection, so an Exotic Class Item must
    // render last no matter which Solver config index carries it. The synthetic
    // entries make every config index reachable deterministically.
    const syntheticOrder = await page.evaluate(() => {
      const legendary = ["helmet", "arms", "chest", "legs"];
      const results = [];
      for (let exoticIndex = 0; exoticIndex < 5; exoticIndex++) {
        const pieces = [];
        const tuningAssignments = [];
        const modAssignments = [];
        let legendaryCursor = 0;
        for (let index = 0; index < 5; index++) {
          const isExotic = index === exoticIndex;
          pieces.push({
            index,
            slot: isExotic ? "classItem" : legendary[legendaryCursor++],
            exotic: isExotic,
            archetypeId: "brawler",
            tertiary: "class",
            tuningMode: "shift",
            tuningTo: "weapons",
          });
          tuningAssignments.push({ mode: "+5-5", to: "weapons", from: "health" });
          modAssignments.push({ stat: "weapons", size: 10, marker: index });
        }
        const rows = window.createEntryPieceRows({kind: "theory", pieces, tuningAssignments, modAssignments});
        results.push({
          exoticIndex,
          order: rows.map(row => row.slot),
          assignmentIndexes: rows.map(row => row.assignmentIndex),
          // The marker is the assignment's own identity: if a row read
          // modAssignments by its *rendered* position instead of its
          // assignmentIndex, these two arrays would not line up.
          renderedMarkers: rows.map(row => row.armorModAssignment?.marker ?? null),
        });
      }
      return results;
    });
    for (const result of syntheticOrder) {
      assert.deepEqual(result.order, CANONICAL_SLOT_ORDER,
        `exotic class item at config index ${result.exoticIndex} must not change UI slot order`);
      assert.deepEqual([...result.assignmentIndexes].sort((left, right) => left - right), [0, 1, 2, 3, 4],
        "every slot must keep a distinct Solver assignment index");
      assert.deepEqual(result.renderedMarkers, result.assignmentIndexes,
        `rows must read modAssignments by assignmentIndex (config index ${result.exoticIndex})`);
    }

    // (3) (7) (8) Tuning vocabulary: the rolled +5 direction and the chosen −5
    // side are named apart, and +3 Balanced has its own label.
    const tuningLabels = await page.evaluate(() => ({
      plus5: window.formatIntrinsicTuning({
        intrinsicTuningMode: "shift", intrinsicTuningTo: "weapons", tuningAssignment: null,
      }),
      plus3: window.formatIntrinsicTuning({
        intrinsicTuningMode: "plus3", intrinsicTuningTo: null, tuningAssignment: null,
      }),
      minus: window.formatFinalMinusTuning({
        intrinsicTuningMode: "shift", tuningAssignment: { mode: "+5-5", to: "weapons", from: "health" },
      }),
      plus3Final: window.formatFinalMinusTuning({
        intrinsicTuningMode: "plus3", tuningAssignment: { mode: "+3" },
      }),
      none: window.formatFinalMinusTuning({ intrinsicTuningMode: "shift", tuningAssignment: null }),
    }));
    assert.match(tuningLabels.plus5, /^\+5\s/, "the intrinsic requirement must read as +5 <stat>");
    assert.match(tuningLabels.minus, /^-5\s/, "the final side must read as -5 <stat>, never +5");
    assert.equal(tuningLabels.plus3, tuningLabels.plus3Final, "+3 Balanced must be labelled the same on both sides");
    assert.equal(tuningLabels.none, "—");

    // (9)-(16) Walk the rendered plans and audit the acquisition plan against
    // the selected entry. A plan with N missing pieces must render exactly N
    // acquisition rows, and a fully owned plan must render none.
    const planRows = Math.min(await page.locator("#planList .inventory-result-option").count(), 20);
    assert.ok(planRows > 0, "the plan browser must render rows");
    let farmPlans = 0;
    let fullyOwnedPlans = 0;
    const exoticLabels = [];
    for (let index = 0; index < planRows; index++) {
      await page.locator("#planList .inventory-result-option").nth(index).click();
      const snapshot = await page.evaluate(() => {
        const entry = window.getSelectedUnifiedEntry();
        const detail = document.getElementById("loadoutDetail");
        const componentRows = [...detail.querySelectorAll(".inventory-result-piece")];
        const acquisitionRows = [...detail.querySelectorAll(".acquisition-row")];
        return {
          kind: entry?.kind || null,
          farmCount: Number(entry?.farmCount ?? 0),
          ownedCount: Number(entry?.ownedCount ?? 0),
          hasPlan: Boolean(detail.querySelector(".acquisition-plan")),
          countText: detail.querySelector(".acquisition-count")?.textContent || "",
          constraints: [...detail.querySelectorAll(".acquisition-constraint-row")]
            .map(node => node.textContent.replace(/\s+/g, " ").trim()),
          rowSlots: componentRows.map(node => node.dataset.pieceSlot),
          rowAssignmentIndexes: componentRows.map(node => Number(node.dataset.assignmentIndex)),
          // Every rendered mod/tuning cell must trace back to its own row's
          // assignment index, never to the row's position.
          assignmentMismatch: componentRows.filter(node => {
            const assignmentIndex = Number(node.dataset.assignmentIndex);
            return entry?.pieces?.[assignmentIndex]?.slot !== node.dataset.pieceSlot;
          }).length,
          farmMods: [...detail.querySelectorAll(".inventory-result-piece.is-farm")].map(node => {
            const assignmentIndex = Number(node.dataset.assignmentIndex);
            return {
              text: (node.querySelector(".armor-mod")?.textContent || "").replace(/\s+/g, " ").trim(),
              assigned: Boolean(entry?.modAssignments?.[assignmentIndex]),
            };
          }),
          plannedFlags: detail.querySelectorAll(".inventory-result-piece.is-farm .armor-cell-flag").length,
          acquisitionSlots: acquisitionRows.map(node => node.dataset.slot),
          acquisitionExotic: acquisitionRows.map(node => node.dataset.exotic === "true"),
          acquisitionTargets: acquisitionRows.map(node => ({
            slot: node.dataset.slot,
            text: (node.querySelector(".acquisition-target")?.textContent || "").trim(),
          })),
          closestNotices: detail.querySelectorAll(".acquisition-notice").length,
          closestDetails: detail.querySelectorAll('details[data-disclosure-key^="acquisition-compare-"]').length,
          closestExpected: (entry?.pieces || [])
            .filter(piece => piece?.closestItem && !(entry?.kind === "inventory" ? piece : piece.item)).length,
          templateDetails: detail.querySelectorAll('details[data-disclosure-key^="acquisition-template-"]').length,
          openTemplateDetails: detail.querySelectorAll('details[data-disclosure-key^="acquisition-template-"][open]').length,
          badges: [...detail.querySelectorAll(".acquisition-badge")].map(node => node.textContent.trim()),
        };
      });

      assert.deepEqual(snapshot.rowSlots, CANONICAL_SLOT_ORDER,
        `plan ${index} must render 头盔→臂铠→胸甲→腿铠→职业物品: ` + JSON.stringify(snapshot.rowSlots));
      assert.equal(snapshot.assignmentMismatch, 0,
        `plan ${index}: a row's assignment index must address the same slot it renders`);

      if (snapshot.farmCount === 0) {
        fullyOwnedPlans++;
        assert.equal(snapshot.hasPlan, false, "a fully owned plan must not render an acquisition panel");
        assert.equal(snapshot.acquisitionSlots.length, 0);
        assert.equal(snapshot.farmMods.length, 0);
        continue;
      }

      farmPlans++;
      assert.equal(snapshot.hasPlan, true, "a plan with missing armor must render the acquisition plan");
      assert.equal(snapshot.acquisitionSlots.length, snapshot.farmCount,
        `plan ${index} must list exactly its ${snapshot.farmCount} missing pieces`);
      assert.match(snapshot.countText, new RegExp(`待刷\\s*${snapshot.farmCount}\\s*件`),
        "the acquisition header must state the farm count: " + snapshot.countText);
      assert.match(snapshot.countText, new RegExp(`已有\\s*${snapshot.ownedCount}/5`),
        "the acquisition header must state the owned count: " + snapshot.countText);
      // The missing-slot list follows the same canonical order as the table.
      assert.deepEqual(snapshot.acquisitionSlots,
        CANONICAL_SLOT_ORDER.filter(slot => snapshot.acquisitionSlots.includes(slot)),
        `plan ${index}: the acquisition list must follow the canonical slot order`);

      // (4) (5) (6) A missing piece still carries the Solver's planned armour
      // mod. `isOwned === false` must never be the reason a mod cell is empty:
      // it is "—" only when the Solver assigned no mod to that piece at all.
      for (const row of snapshot.farmMods) {
        if (!row.assigned) {
          assert.equal(row.text, "—", "a farm piece without a mod assignment must render —: " + row.text);
          continue;
        }
        assert.notEqual(row.text, "—", "a farm piece must not hide its planned armour mod");
        assert.match(row.text, /\+\d+\s/, "a farm armour mod must name its size and stat: " + row.text);
        assert.match(row.text, /计划|計畫|Planned/,
          "a planned armour mod must be flagged as planned, not as a verified instance: " + row.text);
      }
      assert.equal(snapshot.plannedFlags,
        snapshot.farmMods.filter(row => row.assigned).length,
        "every assigned farm armour mod must carry the planned flag");

      // (10) The archetype tally counts missing pieces only: its total can never
      // exceed the farm count, and it must match the missing Legendary count.
      const archetypeRow = snapshot.constraints.find(text => /待刷框架|Missing archetypes/.test(text));
      const missingExotic = snapshot.acquisitionExotic.filter(Boolean).length;
      const tally = sumArchetypeTally(archetypeRow);
      assert.ok(tally <= snapshot.farmCount,
        `plan ${index}: the missing-archetype tally (${tally}) must not exceed the farm count (${snapshot.farmCount})`);
      if (snapshot.farmCount - missingExotic > 0) {
        assert.equal(tally, snapshot.farmCount - missingExotic,
          `plan ${index}: the tally must count exactly the missing Legendary pieces`);
      }

      // (12) (13) Set requirements and Exotics are named explicitly.
      if (snapshot.acquisitionSlots.some(slot => slot !== "classItem")
          && snapshot.badges.some(badge => /套装要求|Set required/.test(badge))) {
        assert.ok(snapshot.constraints.some(text => /套装要求|Set requirement/.test(text)),
          "a set-constrained farm piece must state the set requirement");
      }
      if (missingExotic > 0) {
        assert.ok(snapshot.badges.some(badge => /异域|Exotic/.test(badge)),
          "a missing Exotic must be labelled as an Exotic");
        assert.ok(snapshot.constraints.some(text => /异域护甲|Exotic Armor/.test(text)),
          "the acquisition constraints must name the missing Exotic requirement");
      }

      // (15) closestItem / closestMismatch is surfaced, and only when the
      // Inventory Planner actually produced it.
      if (snapshot.closestExpected > 0) {
        assert.ok(snapshot.closestNotices >= 1,
          "an owned near-miss must be explained instead of silently requiring a farm");
        assert.equal(snapshot.closestDetails, snapshot.closestNotices,
          "every near-miss notice must offer a readable difference breakdown");
      }
      assert.equal(snapshot.openTemplateDetails, 0,
        "acquisition disclosures must start collapsed");
      for (const target of snapshot.acquisitionTargets) {
        exoticLabels.push(target);
      }
    }

    // (11) Every rendered plan is either fully owned or farming, and the two
    // states are handled by their own assertions above.
    assert.ok(farmPlans > 0, "the fixture must contain a plan with missing armor");
    assert.equal(farmPlans + fullyOwnedPlans, planRows, "every rendered plan is either owned or farming");
    // The fully-owned path is also checked synthetically, because an empty
    // fixture cannot be relied on to contain one.
    const fullyOwnedPanel = await page.evaluate(() => {
      const pieces = [];
      const tuningAssignments = [];
      const modAssignments = [];
      for (const slot of ["helmet", "arms", "chest", "legs", "classItem"]) {
        pieces.push({index: pieces.length, slot, item: {name: `Owned ${slot}`, slot}});
        tuningAssignments.push({mode: "+5-5", to: "weapons", from: "health"});
        modAssignments.push({stat: "weapons", size: 10});
      }
      const rows = window.createEntryPieceRows({kind: "theory", pieces, tuningAssignments, modAssignments});
      return {owned: rows.filter(row => row.isOwned).length, html: window.renderAcquisitionPlan(rows)};
    });
    assert.equal(fullyOwnedPanel.owned, 5, "the synthetic entry must be fully owned");
    assert.equal(fullyOwnedPanel.html, "", "a fully owned plan must not render an acquisition panel");

    // (14) Only a class-item Exotic may take a class-item name. A helmet/arms/
    // chest/legs Exotic must keep its own item name.
    const classItemExoticNames = ["Relativism", "Stoicism", "Solipsism",
      "相對主義", "禁慾主義", "唯我主義", "相对主义", "禁欲主义", "唯我主义"];
    for (const {slot, text} of exoticLabels) {
      if (slot === "classItem" || !text) continue;
      for (const name of classItemExoticNames) {
        assert.ok(!text.includes(name),
          `a ${slot} Exotic must not be labelled as an Exotic Class Item (${name}): ${text}`);
      }
    }

    // (16) The exact stat template is collapsed by default and expands to the
    // six-stat layout.
    const templateSummary = page.locator('#loadoutDetail details[data-disclosure-key^="acquisition-template-"]').first();
    if (await templateSummary.count() > 0) {
      assert.equal(await templateSummary.evaluate(element => element.open), false,
        "the exact stat template must start collapsed");
      await templateSummary.locator("summary").click();
      const templateStats = await page.locator('#loadoutDetail details[data-disclosure-key^="acquisition-template-"][open]')
        .first().locator(".acquisition-template-stat")
        .evaluateAll(elements => elements.map(element => ({
          label: (element.querySelector(".acquisition-template-label")?.textContent || "").trim(),
          value: Number(element.querySelector("strong")?.textContent || "NaN"),
          color: getComputedStyle(element).color,
        })));
      assert.equal(templateStats.length, 6, "the exact stat template must show six stats");
      assert.ok(templateStats.every(stat => stat.label.length > 0 && Number.isFinite(stat.value)),
        "every template stat must carry a label and a numeric value: " + JSON.stringify(templateStats));
      assert.ok(new Set(templateStats.map(stat => stat.color)).size > 1,
        "template stats must keep their per-stat colours");
    }

    // (17) (18) (19) (21) The plan browser is a fixed workspace: the panel is
    // bounded, the list scrolls internally, and the toolbar does not move.
    const workspace = await page.evaluate(() => {
      const panel = document.getElementById("planBrowser");
      const list = document.getElementById("planList");
      return {
        panelHeight: Math.round(panel.getBoundingClientRect().height),
        panelPosition: getComputedStyle(panel).position,
        panelOverflow: getComputedStyle(panel).overflow,
        listClientHeight: list.clientHeight,
        listScrollHeight: list.scrollHeight,
        listOverflowY: getComputedStyle(list).overflowY,
        listOverflowX: list.scrollWidth - list.clientWidth,
        renderedRows: list.querySelectorAll(".inventory-result-option").length,
        toolbarOverflowX: (() => {
          const toolbar = document.querySelector(".plan-browser-toolbar");
          return toolbar.scrollWidth - toolbar.clientWidth;
        })(),
      };
    });
    assert.equal(workspace.panelPosition, "sticky", "the desktop plan browser must be a sticky workspace");
    assert.equal(workspace.panelOverflow, "hidden", "the panel must clip its scrolling row");
    assert.equal(workspace.listOverflowY, "auto");
    assert.ok(workspace.listOverflowX <= 2,
      "the plan list must not gain a horizontal scrollbar: " + workspace.listOverflowX);
    assert.ok(workspace.toolbarOverflowX <= 2,
      "the plan toolbar must not widen the panel: " + workspace.toolbarOverflowX);
    assert.ok(workspace.renderedRows >= 10, "the fixture must render a long plan list");
    assert.ok(workspace.panelHeight <= 780,
      "the plan browser must stay bounded on a tall viewport: " + workspace.panelHeight);
    assert.ok(workspace.listScrollHeight > workspace.listClientHeight,
      "the plan list must overflow internally instead of growing the page");

    await page.locator(".inventory-results-layout").scrollIntoViewIfNeeded();
    await page.waitForTimeout(50);
    const beforeScroll = await page.evaluate(() => ({
      pageScroll: window.scrollY,
      toolbarTop: Math.round(document.querySelector(".plan-browser-toolbar").getBoundingClientRect().top),
      pageHeight: document.documentElement.scrollHeight,
    }));
    await page.locator("#planList").evaluate(element => { element.scrollTop = 500; });
    const afterScroll = await page.evaluate(() => ({
      pageScroll: window.scrollY,
      listScrollTop: document.getElementById("planList").scrollTop,
      toolbarTop: Math.round(document.querySelector(".plan-browser-toolbar").getBoundingClientRect().top),
      panelHeight: Math.round(document.getElementById("planBrowser").getBoundingClientRect().height),
    }));
    assert.ok(afterScroll.listScrollTop > 0, "the plan list must own its vertical scroll");
    assert.equal(afterScroll.pageScroll, beforeScroll.pageScroll,
      "scrolling the plan list must not scroll the page");
    assert.ok(Math.abs(afterScroll.toolbarTop - beforeScroll.toolbarTop) <= 1,
      "the plan toolbar must stay in place while the list scrolls");
    assert.ok(afterScroll.panelHeight <= 780,
      "the panel height must not change while its list scrolls");

    // The plan panel is sticky *inside its own row*. While it can hold its sticky
    // offset it must clear the sticky command bar; at the very end of the scroll
    // the row clamps it back down, which is the intended "the panel ends with its
    // loadout" behaviour. Sampling by scroll fraction rather than by fixed offset
    // is required: the pinning window is only as tall as the panel is shorter
    // than the row.
    const stickyStates = [];
    for (const width of [1440, 1200, 1024]) {
      await page.setViewportSize({ width, height: 1000 });
      const maxScroll = await page.evaluate(() =>
        document.documentElement.scrollHeight - window.innerHeight);
      for (const fraction of [0, 0.3, 0.6, 0.75, 0.9, 1]) {
        await page.evaluate(position => window.scrollTo(0, position), Math.round(maxScroll * fraction));
        await page.waitForTimeout(60);
        stickyStates.push(await page.evaluate(() => {
          const bar = document.getElementById("searchCommandBar").getBoundingClientRect();
          const panelElement = document.getElementById("planBrowser");
          const panel = panelElement.getBoundingClientRect();
          const toolbar = document.querySelector(".plan-browser-toolbar").getBoundingClientRect();
          const row = document.querySelector(".inventory-results-layout").getBoundingClientRect();
          const stickyOffset = parseFloat(getComputedStyle(panelElement).top) || 0;
          return {
            width: window.innerWidth,
            scrollY: Math.round(window.scrollY),
            barBottom: Math.round(bar.bottom),
            toolbarTop: Math.round(toolbar.top),
            panelTop: Math.round(panel.top),
            panelBottom: Math.round(panel.bottom),
            rowBottom: Math.round(row.bottom),
            stickyOffset,
            pinned: Math.abs(panel.top - stickyOffset) <= 1 && window.scrollY > 0,
            clampedToRow: Math.abs(panel.bottom - row.bottom) <= 2,
            viewportHeight: window.innerHeight,
          };
        }));
      }
    }
    const describeSticky = states => states.map(state =>
      `${state.width}px@${state.scrollY}:panel=${state.panelTop}-${state.panelBottom}`
      + `/row=${state.rowBottom}/bar=${state.barBottom}/sticky=${state.stickyOffset}`
      + `${state.pinned ? "/PINNED" : ""}${state.clampedToRow ? "/CLAMPED" : ""}`).join(" ");
    const pinnedStates = stickyStates.filter(state => state.pinned);
    assert.ok(pinnedStates.length > 0,
      "the fixture must pin the plan browser at some scroll offset: " + describeSticky(stickyStates));
    for (const state of pinnedStates) {
      assert.ok(state.toolbarTop >= state.barBottom - 1,
        `a pinned plan toolbar must clear the command bar at ${state.width}px: ` + JSON.stringify(state));
      assert.ok(state.panelBottom <= state.viewportHeight + 1,
        `a pinned plan panel must still fit the viewport at ${state.width}px: ` + JSON.stringify(state));
    }
    for (const state of stickyStates) {
      assert.ok(state.panelBottom <= state.rowBottom + 2,
        `the plan panel must stay inside its own row at ${state.width}px / scrollY=${state.scrollY}`);
      assert.ok(state.panelTop >= state.barBottom - 1 || state.clampedToRow,
        `the plan panel may only sit above the command bar once its row clamps it: ` + JSON.stringify(state));
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));

    // (21) 1440p and 4K viewports must not let the list expand without bound.
    for (const height of [1440, 2160]) {
      await page.setViewportSize({ width: 1920, height });
      const capped = await page.locator("#planBrowser")
        .evaluate(element => Math.round(element.getBoundingClientRect().height));
      assert.ok(capped <= 780,
        `the plan browser must stay capped at a ${height}px viewport: ${capped}`);
      const listState = await page.locator("#planList")
        .evaluate(element => ({client: element.clientHeight, scroll: element.scrollHeight}));
      assert.ok(listState.scroll > listState.client,
        `the plan list must keep scrolling internally at a ${height}px viewport`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    // (22) (23) Below 900px the panel becomes a horizontally browsable strip and
    // must not leak the desktop height cap, a second scroll axis or page-level
    // horizontal overflow.
    for (const width of [880, 480, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const narrow = await page.evaluate(() => {
        const panel = document.getElementById("planBrowser");
        const list = document.getElementById("planList");
        const detail = document.getElementById("loadoutDetail");
        return {
          panelPosition: getComputedStyle(panel).position,
          panelHeight: Math.round(panel.getBoundingClientRect().height),
          listOverflowX: getComputedStyle(list).overflowX,
          listOverflowY: getComputedStyle(list).overflowY,
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          acquisitionOverflow: [...detail.querySelectorAll(".acquisition-head, .acquisition-row, .acquisition-field, .acquisition-constraint-row, .acquisition-compare-row")]
            .filter(element => element.scrollWidth > element.clientWidth + 1).length,
          truncatedLabels: [...detail.querySelectorAll(".acquisition-field-label")]
            .filter(element => element.scrollWidth > element.clientWidth + 1).length,
        };
      });
      assert.equal(narrow.panelPosition, "static", `the plan browser must unstick at ${width}px`);
      assert.ok(narrow.panelHeight < 900, `the plan browser must not keep a fixed desktop height at ${width}px`);
      assert.equal(narrow.listOverflowX, "auto", `the plan list must scroll horizontally at ${width}px`);
      assert.equal(narrow.listOverflowY, "hidden", `the plan list must not gain a second scroll axis at ${width}px`);
      assert.ok(narrow.pageOverflow <= 2, `no horizontal page overflow at ${width}px: ${narrow.pageOverflow}`);
      assert.equal(narrow.acquisitionOverflow, 0, `the acquisition plan must not overflow at ${width}px`);
      assert.equal(narrow.truncatedLabels, 0, `acquisition field labels must not be clipped at ${width}px`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    // (24) The plan browser is content-sized, not viewport-sized. It used to
    // carry `height: clamp(320px, 100dvh - …, 760px)`, so a short result set
    // left a dead rectangle under the last row and the panel could not shrink
    // beside a taller loadout. Only the list is capped now: the panel ends where
    // toolbar + list + "show more" end.
    const readBrowser = () => page.evaluate(() => {
      const panel = document.getElementById("planBrowser");
      const list = document.getElementById("planList");
      const row = document.querySelector(".inventory-results-layout");
      const detail = document.getElementById("loadoutDetail");
      const folder = document.querySelector(".plan-browser-more");
      const toolbar = document.querySelector(".plan-browser-toolbar");
      const panelBox = panel.getBoundingClientRect();
      const listBox = list.getBoundingClientRect();
      const rows = [...list.querySelectorAll(".inventory-result-option")];
      const lastRow = rows[rows.length - 1];
      const gap = Number.parseFloat(getComputedStyle(panel).rowGap || "0") || 0;
      return {
        rows: rows.length,
        panelHeight: Math.round(panelBox.height),
        panelContentHeight: Math.round(toolbar.getBoundingClientRect().height
          + listBox.height + (folder ? folder.getBoundingClientRect().height : 0)
          + gap * (folder ? 2 : 1)),
        tailBelowList: Math.round(panelBox.bottom - listBox.bottom),
        deadTail: lastRow ? Math.round(panelBox.bottom - lastRow.getBoundingClientRect().bottom) : null,
        listClient: list.clientHeight,
        listScroll: list.scrollHeight,
        listScrolls: list.scrollHeight > list.clientHeight + 1,
        listTop: Math.round(listBox.top),
        detailHeight: Math.round(detail.getBoundingClientRect().height),
        rowHeight: Math.round(row.getBoundingClientRect().height),
      };
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    const longBrowser = await readBrowser();
    assert.ok(longBrowser.rows >= 10, "the fixture must render a long plan list");
    assert.ok(longBrowser.listScrolls, "a long plan list must scroll inside the panel");
    assert.ok(longBrowser.panelHeight <= longBrowser.panelContentHeight + 2,
      "the panel must not be taller than its own content: " + JSON.stringify(longBrowser));
    assert.ok(longBrowser.tailBelowList <= 2,
      "the panel must not keep empty space under a scrolling list: " + JSON.stringify(longBrowser));

    // The state a short result set produces: the list is a grid whose children
    // are the rows and no app code reads its height, so trimming rows drives the
    // same CSS the fixture cannot otherwise reach (it always solves 12+ plans).
    // The filter is restored afterwards so the later cases see the same list.
    const activeFilter = await page.locator(".plan-chip[aria-pressed=true]").first()
      .evaluate(element => /'([a-z]+)'/.exec(element.getAttribute("onclick") || "")?.[1] || "all");
    const selectedLocator = page.locator("#planList .inventory-result-option[aria-selected=true]");
    const selectedKey = await selectedLocator.count() > 0
      ? await selectedLocator.first().getAttribute("data-plan-key")
      : null;
    const trimmed = await page.evaluate(() => {
      const list = document.getElementById("planList");
      const rows = [...list.querySelectorAll(".inventory-result-option")];
      rows.slice(3).forEach(node => node.remove());
      return rows.length;
    });
    assert.ok(trimmed > 3, "the fixture must expose more than three plans to trim");
    const shortBrowser = await readBrowser();
    assert.equal(shortBrowser.rows, 3, "the short-list case must keep three rows");
    assert.ok(!shortBrowser.listScrolls, "a three-row plan list must not scroll");
    assert.ok(shortBrowser.panelHeight <= shortBrowser.panelContentHeight + 2,
      "a short plan list must collapse the panel to its content: " + JSON.stringify(shortBrowser));
    assert.ok(shortBrowser.deadTail <= 2 && shortBrowser.deadTail >= -2,
      "the last plan row must end at the bottom of the panel: " + JSON.stringify(shortBrowser));
    assert.ok(shortBrowser.panelHeight < 380,
      "a three-row plan browser must not hold a viewport-tall box: " + JSON.stringify(shortBrowser));

    // The right column is free to be taller; the left one must not stretch to it.
    for (const width of [1440, 1920]) {
      await page.setViewportSize({ width, height: width === 1920 ? 1080 : 1000 });
      await page.waitForTimeout(80);
      const state = await readBrowser();
      assert.ok(Math.abs(state.rowHeight - Math.max(state.panelHeight, state.detailHeight)) <= 2,
        `the workspace row must size to its taller column at ${width}px: ` + JSON.stringify(state));
      assert.ok(state.panelHeight <= state.panelContentHeight + 2,
        `the plan panel must stay content-sized beside a taller loadout at ${width}px: `
        + JSON.stringify(state));
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(filter => {
      window.setPlanFilter(filter);
      window.scrollTo(0, 0);
    }, activeFilter);
    await page.locator("#planList .inventory-result-option").first().waitFor();
    if (selectedKey) {
      const row = page.locator(`#planList .inventory-result-option[data-plan-key="${selectedKey}"]`);
      if (await row.count() > 0) await row.first().click();
    }
    const restored = await readBrowser();
    assert.equal(restored.rows, longBrowser.rows,
      "the plan list must be rebuilt after the short-list case: " + JSON.stringify(restored));

    // (25) The footer is one compact credit sentence, not an author table: no
    // UID numbers, both Bilibili profiles still reachable, and a height that
    // stops it reading as a block of metadata.
    const footer = await page.evaluate(() => {
      const element = document.querySelector(".footer");
      const links = [...element.querySelectorAll("a")];
      return {
        height: Math.round(element.getBoundingClientRect().height),
        text: element.innerText.replace(/\s+/g, " ").trim(),
        links: links.length,
        bilibiliLinks: links.filter(link => link.href.includes("space.bilibili.com")).length,
        rows: new Set([...element.querySelectorAll("*")]
          .filter(node => node.textContent.trim())
          .map(node => Math.round(node.getBoundingClientRect().top))).size,
      };
    });
    assert.equal(/\bUID\b/i.test(footer.text), false,
      `the footer must not print a UID: ${footer.text}`);
    assert.equal(/23930138|57597346/.test(footer.text), false,
      `the footer must not print an author id: ${footer.text}`);
    assert.ok(footer.links >= 3, `the footer must keep its links: ${JSON.stringify(footer)}`);
    assert.equal(footer.bilibiliLinks, 2,
      `both Bilibili profiles must stay reachable: ${JSON.stringify(footer)}`);
    assert.ok(footer.height <= 100,
      `the footer must stay one compact credit block at 1440px: ${JSON.stringify(footer)}`);
    // Three distinct tops is the ceiling for the shipped shape: the title row,
    // the credit row, and the taller link box inside it. The author-table
    // layout this replaced measured six.
    assert.ok(footer.rows <= 3,
      `the footer must keep a title row plus one credit row: ${JSON.stringify(footer)}`);

    // (15) An owned Exotic whose identity matches the pinned Exotic but whose
    // stat distribution does not is the exact case the old UI left unexplained:
    // the vault clearly holds the item, yet the plan still demands a farm. Seed
    // one and require the acquisition plan to say why.
    await page.evaluate(storageKeys => {
      const exotic = {
        id: "closest-regression-exotic",
        hash: 910777,
        name: "Closest Regression Exotic",
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
        // Deliberately not any Armor Archetype template, so this copy can never
        // satisfy a plan while still being the same Exotic by name.
        baseStats: {health: 11, melee: 12, grenade: 13, super: 14, class: 15, weapons: 16},
        optimizationBaseStats: {health: 11, melee: 12, grenade: 13, super: 14, class: 15, weapons: 16},
        masterworkTier: 5,
        dataConfidence: {stats: "exact", tuning: "exact"},
        setHash: null,
      };
      localStorage.setItem(storageKeys.upgradeDraft, JSON.stringify({
        schemaVersion: 1, pieces: [], inventory: [exotic],
        setRequirement: {type: "none"}, manualLocked: [],
        importClassFilter: "hunter", importTier5Only: true, reassignModifiers: true,
      }));
      localStorage.setItem(storageKeys.calculatorMode, "solve");
    }, TEST_STORAGE_KEYS);
    await page.reload({ waitUntil: "networkidle" });
    await openAdvancedConstraints(page);
    await page.locator("#inventoryExoticSlotFilter").selectOption("helmet");
    const pinnedExoticValue = await page
      .locator("#inventoryFixedExoticName option", { hasText: "Closest Regression Exotic" })
      .getAttribute("value");
    assert.ok(pinnedExoticValue, "the seeded Exotic must be pinnable by name");
    await page.locator("#inventoryFixedExoticName").selectOption(pinnedExoticValue);
    await page.evaluate(() => window.solve());
    await page.locator("#inventoryResults:not([hidden])").waitFor();

    let closestCase = null;
    const seededPlans = Math.min(await page.locator("#planList .inventory-result-option").count(), 20);
    for (let index = 0; index < seededPlans; index++) {
      await page.locator("#planList .inventory-result-option").nth(index).click();
      // A pinned-but-unmatched Exotic must not disturb the canonical order the
      // table renders, nor the assignment index every row resolves through.
      const seededRowsForSlotOrder = await readLoadoutRows(page);
      assert.deepEqual(seededRowsForSlotOrder.map(row => row.slot), CANONICAL_SLOT_ORDER,
        `plan ${index} with a pinned Exotic must still render the canonical slot order`);
      assert.deepEqual(new Set(seededRowsForSlotOrder.map(row => row.assignmentIndex)),
        new Set([0, 1, 2, 3, 4]),
        `plan ${index} with a pinned Exotic must keep all five assignment indexes reachable`);
      const probe = await page.evaluate(() => {
        const entry = window.getSelectedUnifiedEntry();
        const detail = document.getElementById("loadoutDetail");
        return {
          expected: (entry?.pieces || [])
            .filter(piece => piece?.closestItem && !piece.item).length,
          farmCount: Number(entry?.farmCount ?? 0),
          notices: detail.querySelectorAll(".acquisition-notice").length,
          details: detail.querySelectorAll('details[data-disclosure-key^="acquisition-compare-"]').length,
          noticeText: (detail.querySelector(".acquisition-notice")?.textContent || "").trim(),
        };
      });
      if (probe.expected > 0) { closestCase = probe; break; }
    }
    assert.ok(closestCase, "the seeded near-miss Exotic must reach an acquisition plan");
    assert.equal(closestCase.notices, closestCase.expected,
      "every owned near-miss must produce exactly one notice");
    assert.equal(closestCase.details, closestCase.notices,
      "every near-miss notice must offer a collapsed difference breakdown");
    assert.match(closestCase.noticeText, /相近|similar/i,
      "the notice must explain the mismatch instead of repeating the farm demand: " + closestCase.noticeText);
    // The breakdown is reachable by keyboard and readable without a tooltip.
    const closestBreakdown = page.locator('#loadoutDetail details[data-disclosure-key^="acquisition-compare-"]').first();
    await closestBreakdown.locator("summary").click();
    assert.equal(await closestBreakdown.evaluate(element => element.open), true,
      "the near-miss breakdown must expand");
    const compareRows = await closestBreakdown.locator(".acquisition-compare-row")
      .evaluateAll(elements => elements.map(element => element.textContent.replace(/\s+/g, " ").trim()));
    assert.ok(compareRows.length >= 2, "the breakdown must show the owned and target rolls: " + JSON.stringify(compareRows));

    assert.deepEqual(browserErrors, []);
    console.log("browser smoke: loadout presentation, acquisition plan and plan browser regressions OK");
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

// The reported DIM CSV: exact arithmetic, no socket capability. The page must
// present the certificate's numbers, stay UNVERIFIED (never BLOCKED) and never
// word a data gap as a refusal.
async function checkExactInventoryTotals(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const injected = await page.evaluate(({ storageKeys, inventory, fixture }) => {
      const exotic = inventory.find(item => item.exotic);
      localStorage.setItem(storageKeys.upgradeDraft, JSON.stringify({
        schemaVersion: 1,
        pieces: [],
        inventory,
        setRequirement: fixture.setRequirement,
        manualLocked: [],
        importClassFilter: "hunter",
        importTier5Only: true,
        reassignModifiers: true,
        onlyPlus5Tuning: true,
        exoticSlotFilter: exotic ? exotic.slot : "",
        fixedExoticKey: exotic ? `name:${String(exotic.name).trim().toLocaleLowerCase()}` : "",
      }));
      localStorage.setItem(storageKeys.calculatorMode, "solve");
      return { count: inventory.length, exotic: exotic?.name || null };
    }, { storageKeys: TEST_STORAGE_KEYS, inventory: DIM_ITEMS, fixture: DIM_FIXTURE });
    assert.ok(injected.count > 0, "the DIM fixture must normalize into an inventory");

    await page.reload({ waitUntil: "networkidle" });
    // Targets are plain inputs; fragments are stepped readouts, so they move
    // through the app's own adjuster to keep the budget summary consistent.
    await page.evaluate(({ targets, fragments }) => {
      for (const [stat, value] of Object.entries(targets)) {
        const input = document.getElementById(`target_${stat}`);
        if (!input) continue;
        input.value = String(value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      for (const [stat, value] of Object.entries(fragments)) {
        const current = parseInt(document.getElementById(`fragVal_${stat}`)?.textContent) || 0;
        if (value !== current) window.adjFragment(stat, value - current);
      }
    }, { targets: DIM_FIXTURE.targets, fragments: DIM_FIXTURE.fragments });
    const appliedFragments = await page.evaluate(() => Object.fromEntries(
      ["health", "melee", "grenade", "super", "class", "weapons"]
        .map(stat => [stat, parseInt(document.getElementById(`fragVal_${stat}`)?.textContent) || 0])));
    assert.deepEqual(appliedFragments, DIM_FIXTURE.fragments, "the fixture fragments must be applied before solving");
    await page.evaluate(() => window.solve());
    await page.locator("#inventoryResults:not([hidden])").waitFor();

    // The fixture's two known builds must be listed as exact, and 精确 is the
    // first ranking axis, so they occupy the head of the plan browser.
    assert.ok(
      await page.locator("#planList .inventory-result-option").count() >= DIM_FIXTURE.builds.length,
      "the DIM fixture must produce at least the two reported plans",
    );

    for (let planIndex = 0; planIndex < DIM_FIXTURE.builds.length; planIndex++) {
      await page.locator("#planList .inventory-result-option").nth(planIndex).click();
      const [bars, grid, audit] = await Promise.all([
        readStatBars(page),
        readComparisonGrid(page),
        readSelectedAudit(page),
      ]);
      assert.equal(audit.status, "EXACT_TARGET_PROVEN",
        `plan ${planIndex} must carry an exact certificate, got ${audit.status}`);
      assert.deepEqual(audit.finalTotals, DIM_FIXTURE.targets, `plan ${planIndex} final totals`);
      for (const [statIndex, stat] of STATS.entries()) {
        // The exact number, and 精确/达标 on the same bar — never 10/20 with ✓.
        assert.equal(bars[statIndex].actual, DIM_FIXTURE.targets[stat],
          `plan ${planIndex} ${stat}: the bar must show the proven ${DIM_FIXTURE.targets[stat]}`);
        assert.equal(bars[statIndex].met, true, `plan ${planIndex} ${stat} must read 达标`);
        assert.equal(grid[statIndex].actual, DIM_FIXTURE.targets[stat],
          `plan ${planIndex} ${stat}: the target strip must follow the selected plan`);
        assert.match(grid[statIndex].diff, /精确|精確|Exact/, `plan ${planIndex} ${stat} must read 精确`);
        assert.ok(!(bars[statIndex].met && bars[statIndex].actual < bars[statIndex].target),
          `plan ${planIndex} ${stat}: 达标 while showing ${bars[statIndex].actual}/${bars[statIndex].target}`);
      }
      // No socket objects were imported, so the preflight cannot be BLOCKED and
      // no mod may be reported as uninstallable.
      assert.equal(audit.executionStatus, "UNVERIFIED",
        `plan ${planIndex}: a math-only import is UNVERIFIED, never ${audit.executionStatus}`);
      assert.deepEqual(audit.unassignedMods, [],
        `plan ${planIndex}: no mod may be reported blocked without socket evidence`);
      assert.ok(audit.unverifiedMods.some(mod => mod.reason === "socketCapabilityUnknown"),
        `plan ${planIndex}: the DIM socket gap must be surfaced as unverified`);
      assert.deepEqual(audit.projectedTotals, audit.armorTotals,
        `plan ${planIndex}: projected totals are the bridge back to the solver arithmetic`);
      const note = await page.locator("#loadoutDetail .inventory-projection-note").allInnerTexts();
      for (const text of note) {
        assert.doesNotMatch(text, /被阻止|被阻擋|无法安装|無法安裝|blocked/i,
          `plan ${planIndex}: missing socket data must not be worded as a refusal: ${text}`);
        assert.match(text, /尚未验证|尚未驗證|Unverified/, `plan ${planIndex}: the note must say 尚未验证: ${text}`);
      }
      // The advanced panel keeps all three totals side by side. It is collapsed
      // by default, so read textContent rather than the rendered innerText.
      const advanced = await page.locator('#loadoutDetail details[data-disclosure-key="advanced"] .advanced-totals-grid')
        .first().evaluate(element => ({ text: element.textContent || "", rows: element.children.length }));
      assert.equal(advanced.rows, STATS.length, "the advanced panel must keep one row per stat");
      assert.match(advanced.text, /数学|數學|math/, "the advanced panel must keep the mathematical totals");
      assert.match(advanced.text, /升级后|升級後|projected/, "the advanced panel must keep the projected totals");
      // The third column is an estimate of the post-execution instance state,
      // not a promise that the mods are installable. Wording it "可装" is what
      // made an UNVERIFIED plan read as "confirmed installable".
      assert.match(advanced.text, /执行估算|執行估算|estimated/,
        "the advanced panel must word the third total as an estimate");
      assert.doesNotMatch(advanced.text, /可装|可裝|installable/,
        "the installable subset must not be worded as a promise");
      const preflight = await page.locator('#loadoutDetail details[data-disclosure-key="advanced"] .advanced-row')
        .evaluateAll(elements => elements.map(element => element.textContent || "").join(" "));
      assert.match(preflight, /UNVERIFIED/, "the advanced panel must report the unverified preflight");
      // Evidence class first, raw code second: UNVERIFIED must never be worded
      // as an executable or blocked verdict, and a BLOCKED plan must always
      // carry a named reason family.
      assert.match(preflight, /尚未完全验证|尚未完全驗證|Not fully verified/,
        "UNVERIFIED must be worded as unverified, not as executable: " + preflight);
      assert.doesNotMatch(preflight, /已确认存在执行阻碍|已確認存在執行阻礙|confirmed execution obstacle/,
        "an UNVERIFIED plan must not be worded as a confirmed obstacle");
      assert.doesNotMatch(preflight, /witnessTotalsMismatch/, "a math-only import must not fabricate a witness mismatch");
    }
    assert.deepEqual(browserErrors, []);
    console.log("browser smoke: exact DIM inventory totals / execution tri-state OK");
  } finally {
    await context.close();
  }
}

// ============================================================
// Information architecture + saved-plan workspace
// ============================================================
// The documented goals of the v3.3 refactor are checkable, so they are checked:
// nothing huge above the fold, help behind a disclosure, advanced constraints
// collapsed, one editor at a time, a result hero that answers "can I / how many
// swaps / how many kept", and a saved-plan manager that is a drawer instead of
// a permanent card at the bottom of the page.
async function checkInformationArchitecture(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });

    // (1) No program-introduction card in the document flow, and the free
    // notice is a single compact line rather than the first screen's hero.
    assert.equal(await page.locator("#mainContent .card--intro").count(), 0,
      "the program introduction must not occupy document flow");
    const notice = await page.locator("#freeNotice").evaluate(element => {
      const box = element.getBoundingClientRect();
      return { display: getComputedStyle(element).display, height: box.height, text: element.innerText };
    });
    assert.notEqual(notice.display, "none", "the free notice must still be shown");
    assert.ok(notice.height <= 46, `the free notice must stay compact: ${notice.height}px`);
    assert.match(notice.text, /完全免费/, "the free notice must keep the free claim");

    // (2) Help is a real link that leaves the current solve intact.
    assert.equal(await page.locator('#programIntroDrawer').count(), 0);
    assert.equal(await page.locator('#userGuideLink').getAttribute('href'), '../guide/');
    assert.equal(await page.locator('#userGuideLink').getAttribute('aria-haspopup'), null);
    assert.equal(await page.locator('.notice-free-more').getAttribute('href'), '../guide/#disclaimer');
    const popupPromise = page.waitForEvent('popup');
    await page.locator('#userGuideLink').click();
    const guide = await popupPromise;
    await guide.waitForLoadState('networkidle');
    assert.equal(new URL(guide.url()).pathname, new URL('../guide/', baseUrl).pathname);
    assert.equal(await guide.evaluate(() => window.opener === null), true);
    await guide.close();

    // (3) Advanced constraints are one collapsed summary line by default, and
    // "how do I import" is a help affordance rather than a permanent paragraph.
    assert.equal(await page.locator("#advancedConstraints").getAttribute("open"), null,
      "advanced constraints must be collapsed by default");
    assert.match(await page.locator("#advancedConstraintsSummary").innerText(), /未设置|未設定|Not set/);
    assert.equal(await page.locator('#dimImportGuideLink').getAttribute('href'), '../guide/#dim-import');

    // (4) One thin row per constraint once set: the summary names both.
    await page.evaluate(() => window.setCalculatorMode("upgrade"));
    assert.equal(await page.locator("#upgradeBuildEditor .upgrade-piece-row").count(), 5);
    assert.equal(await page.locator("#upgradeBuildEditor .upgrade-piece-row[open]").count(), 0,
      "five collapsed summaries by default");
    await page.locator("#advancedConstraints > summary").click();
    await page.locator("#setReqMode").selectOption("set2");
    const summary = await page.locator("#advancedConstraintsSummary").innerText();
    assert.match(summary, /套装|套裝|Set/, `the collapsed summary must name the set: ${summary}`);
    await page.locator("#setReqMode").selectOption("none");

    // (5) Set effects stay behind 查看套装效果.
    assert.equal(await page.locator(".set-effects-toggle").getAttribute("open"), null,
      "2pc/4pc bonus prose must be collapsed");
    const setSummary = await page.locator(".set-requirement-summary").innerText();
    assert.match(setSummary, /未要求套装|未要求套裝|No set requirement/);

    // (6) The replacement result hero answers the three questions at a glance.
    await page.evaluate(() => { window.setCalculatorMode("upgrade"); });
    await page.locator("#btnUpgradeAnalyze").click();
    await page.locator("#upgradeResults:not([hidden])").waitFor({ timeout: 60000 });
    await page.locator("#btnUpgradeAnalyze:not([disabled])").waitFor({ timeout: 60000 });
    const hero = await page.locator("#upgradeResults .upgrade-hero").first().evaluate(element => ({
      tone: element.className,
      eyebrow: (element.querySelector(".upgrade-eyebrow")?.textContent || "").trim(),
      headline: (element.querySelector(".upgrade-recommendation")?.textContent || "").trim(),
      outcome: (element.querySelector(".upgrade-outcome strong")?.textContent || "").trim(),
      note: (element.querySelector(".upgrade-outcome span")?.textContent || "").trim(),
    }));
    assert.match(hero.headline, /换 \d+ 件|不用换|重配|Keep all five|Replace \d+/, `hero headline: ${hero.headline}`);
    assert.match(hero.tone, /is-met|is-short|is-pending/, `hero tone must be stateful: ${hero.tone}`);
    assert.match(hero.outcome, /达标|達標|还差|還差|short|met/i, `hero outcome: ${hero.outcome}`);
    assert.match(hero.note, /替换|替換|保留|kept|replacement/i,
      `hero must state replacement and kept counts: ${hero.note}`);
    // Prose lives behind a disclosure, not in the hero's first paint.
    assert.equal(await page.locator("#upgradeResults .upgrade-hero-more").getAttribute("open"), null,
      "the hero must not unfold its prose by default");

    // (7) The replacement path is a plan, and the mod table is collapsed.
    if (await page.locator("#upgradeResults .upgrade-plan-head h3").count() > 0) {
      assert.match(await page.locator("#upgradeResults .upgrade-plan-head h3").innerText(),
        /推荐替换路径|建議替換路徑|Recommended replacement path/);
      assert.match(await page.locator("#upgradeResults .upgrade-plan-summary").innerText(),
        /换 \d+ 件|還差|Replace \d+|short/);
      assert.match(await page.locator("#upgradeResults .upgrade-plan-kept").innerText(),
        /保留|Keep/);
    }
    const assignments = page.locator(
      "#upgradeResults details.upgrade-assignment-details:not(.witness-breakdown)",
    );
    if (await assignments.count() > 0) {
      assert.equal(await assignments.first().getAttribute("open"), null,
        "final tuning/mods must be collapsed by default");
      assert.match(await assignments.first().locator("summary").first().innerText(),
        /最终调整与模组配置|最終調校與模組配置|Final Tuning/);
    }

    // (8) Saved plans are a global drawer, not a card at the bottom.
    assert.equal(await page.locator("#savedCard").count(), 0,
      "the bottom-of-page saved-builds card must be gone");
    assert.equal(await page.locator("#savedBuildsDrawer").isHidden(), true);

    // (9)/(10) Save stores the *selected* plan's own witness and the manager can
    // load and delete it.
    await page.evaluate(() => window.setCalculatorMode("solve"));
    await page.evaluate(() => window.solve());
    await page.locator("#inventoryResults:not([hidden])").waitFor({ timeout: 60000 });
    await page.locator("#btnSolve:not([disabled])").waitFor({ timeout: 60000 });
    const secondRow = page.locator("#planList .inventory-result-option").nth(1);
    const secondKey = await secondRow.getAttribute("data-plan-key");
    await secondRow.click();
    const selectedAudit = await page.evaluate(() => {
      const entry = window.getSelectedUnifiedEntry();
      return {
        canonicalId: entry?.witness?.canonicalId || null,
        key: entry ? window.unifiedEntryKey(entry) : null,
      };
    });
    assert.equal(selectedAudit.key, secondKey,
      "the selected entry must be the row that was clicked");
    await page.locator("#loadoutDetail .inventory-result-actions button", { hasText: "保存" }).click();
    await page.locator("#saveBuildDialog:not([hidden])").waitFor();
    await page.locator("#saveBuildName").fill("IA regression");
    await page.locator("#saveBuildDialog button[type=submit]").click();
    await page.locator("#saveBuildDialog").waitFor({ state: "hidden" });
    const saved = await page.evaluate(() => window.getSavedBuilds()[0]);
    assert.equal(saved.name, "IA regression");
    assert.ok(saved.result, "a saved plan must carry its sealed witness");
    assert.equal(saved.result.canonicalId, selectedAudit.canonicalId,
      "the saved plan must be the selected entry, not the theory solver's cursor");
    assert.equal(await page.locator("#savedBuildsCount").innerText(), "1",
      "the header entry must show how many plans are saved");

    await page.locator("#openSavedBuilds").click();
    await page.locator("#savedBuildsDrawer:not([hidden])").waitFor();
    const item = page.locator("#savedBuildsList .saved-item", { hasText: "IA regression" });
    await item.waitFor();
    const itemBox = await item.boundingBox();
    assert.ok(itemBox.height <= 150,
      `a saved plan must be a compact list row, not a card (${Math.round(itemBox.height)}px)`);
    // Clicking the row selects it and must not touch the working state.
    await item.locator(".saved-item-name, .saved-item-main").first().click();
    assert.equal(await item.evaluate(element => element.classList.contains("is-selected")), true,
      "clicking a saved plan must select it");
    assert.equal(await page.evaluate(() => window.getSavedBuilds().length), 1,
      "selecting a saved plan must not mutate stored plans");
    // Delete asks first, then offers an Undo. Earlier toasts (the save notice)
    // may still be on screen, so target the toast that carries the action.
    page.once("dialog", dialog => dialog.accept());
    await item.locator(".saved-item-delete").click();
    await page.waitForFunction(() => window.getSavedBuilds().length === 0);
    const undoToast = page.locator("#toastStack .toast", { has: page.locator(".toast-action") });
    await undoToast.first().waitFor();
    assert.match(await undoToast.first().innerText(), /撤销|復原|Undo/,
      "deleting must offer an Undo toast");
    await undoToast.first().locator(".toast-action").click();
    await page.waitForFunction(() => window.getSavedBuilds().length === 1);
    // Load closes the drawer and keeps the reader on the same page.
    await item.locator(".saved-item-load").click();
    await page.locator("#savedBuildsDrawer").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.getSavedBuilds().length), 1,
      "loading must not consume the saved plan");

    // (15) Switching plans keeps the header, the detail and the save action on
    // one and the same entry.
    const firstKey = await page.locator("#planList .inventory-result-option").first().getAttribute("data-plan-key");
    await page.locator("#planList .inventory-result-option").first().click();
    const consistency = await page.evaluate(() => ({
      entryKey: window.unifiedEntryKey(window.getSelectedUnifiedEntry()),
      entryCanonicalId: window.getSelectedUnifiedEntry()?.witness?.canonicalId || null,
      selected: document.querySelector("#planList .inventory-result-option[aria-selected='true']")?.getAttribute("data-plan-key") || null,
      label: (document.querySelector("#loadoutDetail .inventory-result-detail-label")?.textContent || "").trim(),
    }));
    assert.equal(consistency.entryKey, firstKey,
      "the selected entry must be the row marked selected");
    assert.equal(consistency.selected, firstKey);
    assert.match(consistency.label, /#01/, `the detail header must follow the selection: ${consistency.label}`);
    // Saving now must store the *first* plan, not the one selected before.
    await page.locator("#loadoutDetail .inventory-result-actions button", { hasText: "保存" }).click();
    await page.locator("#saveBuildName").fill("IA reselect");
    await page.locator("#saveBuildDialog button[type=submit]").click();
    const newest = await page.evaluate(() => window.getSavedBuilds()[0]);
    assert.equal(newest.name, "IA reselect");
    assert.equal(newest.result.canonicalId, consistency.entryCanonicalId,
      "Save must resolve the currently selected unified entry");

    // (7b) The plan browser still owns its own vertical scroll.
    const panel = await page.locator("#planBrowser").evaluate(element => ({
      position: getComputedStyle(element).position,
      overflowY: getComputedStyle(element).display === "none" ? null : getComputedStyle(element).overflow,
    }));
    assert.equal(panel.position, "sticky", "the plan browser must stay a bounded sticky workspace");

    assert.deepEqual(browserErrors, []);
    console.log("browser smoke: information architecture / saved-plan workspace OK");
  } finally {
    await context.close();
  }
}

// One workspace measure, used from first paint. A solve must not move the
// layout, and the wide layout must actually spend the width it claims: six
// stats on one row, a three-lane replacement step, capped controls.
async function checkWorkspaceLayout(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  const readContainer = () => page.evaluate(() => {
    const rect = document.querySelector(".container").getBoundingClientRect();
    return {
      width: Math.round(rect.width),
      left: Math.round(rect.left),
      available: document.documentElement.clientWidth,
    };
  });
  const readOverflow = () => page.evaluate(() => {
    const doc = document.documentElement;
    return {
      viewport: doc.clientWidth,
      content: doc.scrollWidth,
      offenders: [...document.querySelectorAll("body *")]
        .filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.right > doc.clientWidth + 1 || rect.left < -1;
        })
        .slice(0, 6)
        .map(element => `${element.tagName}${element.id ? "#" + element.id : ""}.`
          + String(element.className || "").slice(0, 40)),
    };
  });
  const assertNoOverflow = async label => {
    const overflow = await readOverflow();
    assert.ok(
      overflow.content <= overflow.viewport + 1,
      `document horizontal overflow at ${label}: ${JSON.stringify(overflow)}`,
    );
  };
  // The same owned-armor fixture the other regressions build, so the optimize
  // flow has real replacement candidates to plan steps from.
  const seedOwnedArmor = () => page.evaluate(({ storageKeys, configs }) => {
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
              id: `layout-regression-${id++}`,
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
    localStorage.setItem(storageKeys.upgradeDraft, JSON.stringify({
      schemaVersion: 1,
      pieces: [],
      inventory,
      setRequirement: { type: "none" },
      manualLocked: [],
      importClassFilter: "hunter",
      importTier5Only: true,
      reassignModifiers: true,
    }));
    localStorage.setItem(storageKeys.calculatorMode, "solve");
  }, { storageKeys: TEST_STORAGE_KEYS, configs: BASE_CONFIGS });

  try {
    // (1) The input page already uses the wide measure — there is no
    // "narrow before solving" state left to regress to.
    const before = {};
    for (const width of [1920, 1440, 1280, 1024, 800, 600, 390]) {
      await page.setViewportSize({ width, height: width <= 800 ? 720 : 1000 });
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      if (width >= 1280) before[width] = await readContainer();
      await assertNoOverflow(`${width}px input page`);
    }
    assert.ok(
      before[1920].width >= 1500 && before[1920].width <= 1524,
      `1920px must already use the capped wide measure: ${JSON.stringify(before[1920])}`,
    );
    for (const width of [1440, 1280]) {
      assert.ok(
        before[width].width >= 1200,
        `the input page at ${width}px must not fall back to the old 1180px measure: `
        + JSON.stringify(before[width]),
      );
      // `scrollbar-gutter: stable` reserves the scrollbar's width inside the
      // root, so the container fills the viewport minus that gutter.
      assert.ok(
        before[width].width >= before[width].available - 20,
        `at ${width}px the workspace must fill the viewport: ${JSON.stringify(before[width])}`,
      );
    }

    // (2) Solving must not move the container: same width, same left edge.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await seedOwnedArmor();
    await page.reload({ waitUntil: "networkidle" });
    await page.evaluate(() => window.setCalculatorMode("upgrade"));
    await page.locator("#btnUpgradeAnalyze").click();
    await page.locator("#upgradeResults:not([hidden])").waitFor({ timeout: 60000 });
    await page.locator("#btnUpgradeAnalyze:not([disabled])").waitFor({ timeout: 60000 });

    const after = {};
    for (const width of [1920, 1440, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(150);
      after[width] = await readContainer();
      assert.ok(
        Math.abs(after[width].width - before[width].width) <= 2,
        `the workspace width must not change when results land (${width}px): `
        + `before ${before[width].width}, after ${after[width].width}`,
      );
      assert.ok(
        Math.abs(after[width].left - before[width].left) <= 2,
        `the workspace left edge must not shift when results land (${width}px): `
        + `before ${before[width].left}, after ${after[width].left}`,
      );
      await assertNoOverflow(`${width}px result workspace`);

      // (3) The six-stat readouts stay on one row once there is room for six:
      // the optimize result's stat comparison and the six target inputs.
      // Measured as geometry — Blink may serialise the track list as
      // `repeat(6, …)`, which does not split into six tokens.
      for (const [selector, label] of [
        [".upgrade-stat-comparison", "the result stat comparison"],
        ["#targetGrid", "the six target inputs"],
      ]) {
        const grid = await page.locator(selector).first().evaluate(element => {
          const cells = [...element.children];
          const raw = getComputedStyle(element).gridTemplateColumns;
          const repeat = raw.match(/^repeat\((\d+),/);
          return {
            cells: cells.length,
            rows: new Set(cells.map(cell => Math.round(cell.getBoundingClientRect().top))).size,
            tracks: repeat ? Number(repeat[1]) : raw.split(" ").filter(Boolean).length,
          };
        });
        assert.equal(grid.cells, 6, `${label} must render six cells at ${width}px`);
        assert.equal(grid.rows, 1, `${label} must be a single row at ${width}px`);
        assert.equal(grid.tracks, 6, `${label} must keep six columns at ${width}px`);
      }
    }

    // (4) The replacement path spends its width on three lanes instead of one
    // narrow column plus empty space, and each step stays a row, not a card.
    let stepHeight = null;
    if (await page.locator("#upgradeResults .upgrade-plan-step").count() > 0) {
      const lane = await page.locator("#upgradeResults .upgrade-plan-step").first()
        .evaluate(element => {
          const lanes = element.querySelector(".upgrade-plan-lanes");
          const laneElements = [...element.querySelectorAll(".upgrade-plan-lane")];
          const raw = lanes ? getComputedStyle(lanes).gridTemplateColumns : "";
          const repeat = raw.match(/^repeat\((\d+),/);
          return {
            laneColumns: repeat ? Number(repeat[1]) : raw.split(" ").filter(Boolean).length,
            laneCount: laneElements.length,
            laneRows: new Set(laneElements.map(item => Math.round(item.getBoundingClientRect().top))).size,
            stepHeight: Math.round(element.getBoundingClientRect().height),
          };
        });
      stepHeight = lane.stepHeight;
      assert.equal(lane.laneCount, 3, "a replacement step must expose three regions");
      assert.equal(lane.laneColumns, 3, "a wide replacement step must lay those regions out in a row");
      assert.equal(lane.laneRows, 1, "the three replacement regions must share one row");
      assert.ok(
        lane.stepHeight <= 160,
        `a wide replacement step must stay compact instead of stacking into a card: ${lane.stepHeight}px`,
      );
    }

    // (5) Five-piece summaries are aligned columns at this width. The cells are
    // vertically centred, so "one row" is read from the column positions, not
    // from their tops.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(150);
    const pieceSummary = await page.locator("#upgradeBuildEditor .upgrade-piece-row summary")
      .first().evaluate(element => {
        const identity = element.querySelector(".upgrade-piece-identity");
        const cells = [...identity.children].map(cell => cell.getBoundingClientRect());
        const raw = getComputedStyle(identity).gridTemplateColumns;
        const repeat = raw.match(/^repeat\((\d+),/);
        return {
          display: getComputedStyle(identity).display,
          cells: cells.length,
          columns: new Set(cells.map(cell => Math.round(cell.left))).size,
          tracks: repeat ? Number(repeat[1]) : raw.split(" ").filter(Boolean).length,
          identityHeight: Math.round(identity.getBoundingClientRect().height),
        };
      });
    assert.equal(pieceSummary.display, "grid", "a wide piece summary must use aligned columns");
    assert.equal(pieceSummary.tracks, 5, "a wide piece summary must expose five aligned columns");
    assert.equal(
      pieceSummary.columns,
      pieceSummary.cells,
      `every piece-summary cell must own a column: ${JSON.stringify(pieceSummary)}`,
    );
    assert.ok(
      pieceSummary.identityHeight <= 76,
      `the piece summary cells must not stack into a column: ${pieceSummary.identityHeight}px tall`,
    );

    // (6) A control follows its parent's width only up to a sensible cap.
    await openAdvancedConstraints(page);
    const controlWidths = await page.evaluate(() => {
      const measure = selector => {
        const element = document.querySelector(selector);
        return element ? Math.round(element.getBoundingClientRect().width) : null;
      };
      return {
        container: Math.round(document.querySelector(".container").getBoundingClientRect().width),
        importClass: measure("#importClass"),
        setReqMode: measure("#setReqMode"),
      };
    });
    for (const [name, width] of [["#importClass", controlWidths.importClass], ["#setReqMode", controlWidths.setReqMode]]) {
      assert.ok(width !== null && width > 0, `${name} must be rendered`);
      assert.ok(width <= 342, `${name} must keep its own max-width instead of filling the row: ${width}px`);
      assert.ok(
        width < controlWidths.container / 3,
        `${name} must not stretch with the workspace: ${width}px in ${controlWidths.container}px`,
      );
    }

    assert.deepEqual(browserErrors, []);
    console.log(
      "browser smoke: one workspace measure (no solve-time width jump), six-up stats, "
      + `three-lane replacement steps${stepHeight === null ? "" : ` (~${stepHeight}px each)`}, capped controls OK`,
    );
  } finally {
    await context.close();
  }
}

async function checkGuide(browser) {
  await access(path.resolve('dist/guide/index.html'));
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(new URL('../guide/#dim-import', baseUrl).href, { waitUntil: 'networkidle' });
    for (const [language, copy] of Object.entries(GUIDE_CONTENT)) {
      await page.locator('#guideLanguage').selectOption(language);
      assert.equal(await page.locator('html').getAttribute('lang'), copy.lang);
      assert.equal(await page.locator('#guideTitle').innerText(), copy.title);
      for (const [id] of copy.sections) assert.equal(await page.locator(`section#${id}`).count(), 1);
      for (const width of [1440, 760, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForFunction(open => document.getElementById('guideContents').open === open, width > 760);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${language} overflow at ${width}`);
        assert.equal(await page.locator('#guideContents').getAttribute('open') !== null, width > 760);
      }
    }
    await page.locator('#guideContents summary').click();
    await page.locator('#guideNav a[href="#disclaimer"]').click();
    assert.equal(await page.locator('#guideContents').getAttribute('open'), null);
    assert.equal(new URL(page.url()).hash, '#disclaimer');
    assert.ok(await page.locator('#disclaimer').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return rect.top >= 0 && rect.top < innerHeight;
    }));
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('#guideLanguage').inputValue(), 'en');
    assert.equal(await page.locator('#backLink').getAttribute('href'), '../app/');
    for (const [name, width] of [['desktop', 1440], ['mobile', 390]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: `.impeccable/review/${name}.png`, fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log('browser smoke: guide languages, anchors, links and mobile overflow OK');
  } finally { await context.close(); }
}

async function checkComposedGuides(browser) {
  const root = await mkdtemp(path.join(tmpdir(), 'd2-guide-browser-'));
  let composedServer;
  const context = await browser.newContext();
  try {
    const development = path.join(root, 'development');
    const stable = path.join(root, 'stable');
    const output = path.join(root, 'pages');
    await cp(path.resolve('dist'), stable, { recursive: true });
    await build({ configFile: 'vite.config.mjs',
      define: { __BUILD_CHANNEL__: JSON.stringify('develop') },
      build: { outDir: development },
    });
    await composePages({ stableDirectory: stable, developmentDirectory: development,
      outputDirectory: output, stableCommit: 'test-stable', developmentCommit: 'test-develop' });
    composedServer = await preview({ configFile: 'vite.config.mjs', build: { outDir: output },
      preview: { host: '127.0.0.1', port: 0, strictPort: false } });
    const origin = composedServer.resolvedUrls.local[0];
    const page = await context.newPage();
    for (const prefix of ['', 'dev/']) {
      await access(path.join(output, prefix, 'guide/index.html'));
      await page.goto(new URL(`${prefix}app/`, origin).href, { waitUntil: 'networkidle' });
      await page.locator('#pageLanguage').selectOption('zh-cht');
      const href = await page.locator('#userGuideLink').getAttribute('href');
      assert.equal(href, '../guide/');
      await page.goto(new URL(href, page.url()).href, { waitUntil: 'networkidle' });
      assert.equal(new URL(page.url()).pathname, `/${prefix}guide/`);
      assert.equal(await page.locator('#guideLanguage').inputValue(), 'zh-cht');
      assert.equal(await page.locator('#guideSections section').count(), 17);
      assert.equal(new URL(await page.locator('#backLink').getAttribute('href'), page.url()).pathname, `/${prefix}app/`);
    }
    console.log('browser smoke: composed stable /guide/ and develop /dev/guide/ OK');
  } finally {
    await context.close();
    await composedServer?.close();
    await rm(root, { recursive: true, force: true });
  }
}

let browser;
try {
  browser = await chromium.launch({
    executablePath: await findChrome(),
    headless: true,
  });
  await checkPortal(browser);
  await checkGuide(browser);
  await checkComposedGuides(browser);
  await checkInventoryPlanning(browser);
  await checkUpgradeTargetSync(browser);
  await checkCancelledReachabilityProbe(browser);
  await checkSetRequirementSnapshot(browser);
  await checkBungieLoginHidden(browser);
  await checkResultWorkspace(browser);
  await checkLoadoutPresentation(browser);
  await checkExactInventoryTotals(browser);
  await checkInformationArchitecture(browser);
  await checkWorkspaceLayout(browser);
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
  assert.equal(await page.locator("#targetGrid input[id^=\"target_\"]").count(), 6);
  assert.equal(await page.locator("#fragmentGrid .fragment-stepper").count(), 6);
  assert.equal(await page.locator("#targetGrid .stat-mode-controls").count(), 6);
  assert.equal(await page.locator("#targetGrid .stat-mode-control").count(), 12);
  assert.match(await page.locator("#priorityBadge_health").innerText(), /优先\s*无/);
  assert.match(await page.locator("#fuzzyBadge_health").innerText(), /规则\s*=\s*精确/);
  await page.locator("#priorityBadge_health").click();
  assert.match(await page.locator("#priorityBadge_health").innerText(), /优先\s*高/);
  await page.locator("#fuzzyBadge_health").click();
  assert.match(await page.locator("#fuzzyBadge_health").innerText(), /规则\s*≥\s*至少/);

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
  await page.waitForFunction(storageKey => (
    JSON.parse(localStorage.getItem(storageKey) || "null")
      ?.onlyPlus5Tuning === true
  ), TEST_STORAGE_KEYS.currentDraft);
  await page.evaluate(() => window.solve());
  await page.locator("#results.show").waitFor();
  assert.equal(await page.locator("#comparisonGrid .comp-item").count(), 6);
  const armorTuningCells = await page.locator("#inventoryResults .armor-tuning")
    .evaluateAll(elements => elements.map(element => element.textContent));
  assert.ok(
    armorTuningCells.length > 0,
    "the five-piece armor table should expose one Tuning cell per piece",
  );
  assert.ok(
    armorTuningCells.every(text => !text.includes("+3")),
    "+5/-5-only solutions should not contain +3 tuning: " + JSON.stringify(armorTuningCells),
  );
  await page.locator('#inventoryResults details[data-disclosure-key="advanced"] > summary').click();
  await page.locator('#inventoryResults details[data-disclosure-key="advanced-allocation"] > summary').click();
  assert.equal(
    await page.locator("#inventoryResults .solution-tuning-plus3").count(),
    0,
    "+5/-5-only solutions should not report a +3 allocation",
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
  const workerProbe = await page.evaluate(fixedPiece => new Promise((resolve, reject) => {
    const worker = new Worker(window.__armorWorkerUrls.find(url => url.includes("armor-engine.worker")), {type: "module"});
    const timer = setTimeout(() => { worker.terminate(); reject(new Error("audit Worker probe timed out")); }, 15000);
    worker.onmessage = ({data}) => {
      clearTimeout(timer); worker.terminate();
      if (data.error) reject(new Error(data.error.message)); else resolve(data.result);
    };
    worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
    const target = {health: 200, melee: 75, grenade: 125, super: 25, class: 25, weapons: 25};
    worker.postMessage({id: "audit-clamp", operation: "calculateReachability", payload: {
      fixedPiece, numPlus3: "0", numPlus5: "0", numPlus10: "5", fragments: {}, lockedTargets: {}, probeTarget: target,
    }});
  }), BASE_CONFIGS[0]);
  assert.equal(workerProbe.status, "EXACT_TARGET_PROVEN");
  assert.equal(workerProbe.certificate.witnessVerification.armorTotals.health, 225);
  const stagedProbe = await page.evaluate(fixedPiece => new Promise((resolve, reject) => {
    const worker = new Worker(window.__armorWorkerUrls.find(url => url.includes("armor-engine.worker")), {type: "module"});
    const frames = [];
    const timer = setTimeout(() => {worker.terminate(); reject(new Error("staged Worker timeout"));}, 10000);
    worker.onmessage = ({data}) => {
      frames.push({type: data.type, generation: data.generation, search: data.search || data.result?.search,
        status: data.result?.certificate?.status, verified: data.result?.certificate?.witnessVerification?.valid});
      if (data.type === "error") {clearTimeout(timer); worker.terminate(); reject(new Error(data.error.message));}
      if (data.type === "result") {clearTimeout(timer); worker.terminate(); resolve(frames);}
    };
    const slots = ["helmet", "arms", "chest", "legs", "classItem"];
    const stats = ["health", "melee", "grenade", "super", "class", "weapons"];
    const items = slots.map((slot, index) => ({...fixedPiece, id: `staged-${index}`, hash: 100 + index,
      slot, classId: "hunter", archetypeId: fixedPiece.archetype, effectiveBaseStats: {...fixedPiece.baseStats},
      optimizationBaseStats: {...fixedPiece.baseStats}, masterworkTier: 5,
      tuningMode: "plus3", tunedStat: "health", allowedTuningStats: ["health"], armorModSize: 0,
      dataConfidence: {stats: "exact", tuning: "exact"}}));
    const targets = Object.fromEntries(stats.map(stat => [stat, 5 * (fixedPiece.baseStats[stat] + Number(fixedPiece.masterworkStats.includes(stat)))]));
    worker.postMessage({type: "start", id: "staged", generation: 77, operation: "solveInventory", payload: {
      searchProfile: "balanced", items, targets, fragments: {}, reassignModifiers: false,
      setRequirement: {type: "none"}, userConstraints: {exact: Object.fromEntries(stats.map(stat => [stat, true]))},
    }});
  }), BASE_CONFIGS[0]);
  assert.ok(stagedProbe.some(event => event.type === "progress" && event.verified && event.status === "EXACT_TARGET_PROVEN"));
  assert.ok(stagedProbe.every(event => event.generation === 77));
  assert.equal(stagedProbe.at(-1).type, "result");
  assert.equal(stagedProbe.at(-1).search.running, false);
  await page.locator('#searchProfile').selectOption('fast');
  assert.match(await page.locator('#searchProfileHelp').innerText(), /200/);
  await page.locator('#searchProfile').selectOption('deep');
  await page.evaluate(() => { window.__cancelledSearch = window.solve(); });
  await page.locator('#cancelSearch').waitFor({state: 'visible'});
  await page.waitForFunction(() => !document.getElementById('cancelSearch').disabled);
  await page.locator('#cancelSearch').click();
  await page.evaluate(() => window.__cancelledSearch);
  assert.match(await page.locator('#searchStatus').innerText(), /停止|stopped/);
  await page.locator('#searchProfile').selectOption('balanced');

  await page.evaluate(() => window.setCalculatorMode("upgrade"));
  assert.equal(await page.locator("#upgradeBuildCard").getAttribute("hidden"), null);
  assert.equal(
    await page.locator("#upgradeBuildCard .upgrade-card-header h2").count(),
    1,
    "the current-loadout editor should use one consolidated heading component",
  );
  assert.equal(
    await page.locator("#upgradeBuildCard .upgrade-current-head").count(),
    0,
    "the duplicate current-loadout heading should be removed",
  );
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
  // Five compact summaries by default: no editor is expanded until asked for,
  // and the card therefore stays short even with all five pieces present.
  assert.equal(
    await page.locator("#upgradeBuildEditor .upgrade-piece-row[open]").count(),
    0,
    "the current-loadout editor must default to five collapsed summaries",
  );
  assert.equal(
    await page.locator("#upgradeBuildEditor .upgrade-piece-fields:visible").count(),
    0,
    "no piece editor may be rendered until its summary is expanded",
  );

  const firstIdentity = await page.locator(
    "#upgradeBuildEditor .upgrade-piece-identity",
  ).first().innerText();
  assert.match(firstIdentity, /-5/, "piece summary should name the -5 stat");
  assert.match(firstIdentity, /\+10/, "piece summary should name the +10 stat mod");

  // Expanding one piece reveals exactly one editor, on a compact 2x3 grid.
  await page.locator("#upgradeBuildEditor .upgrade-piece-row summary").first().click();
  assert.equal(
    await page.locator("#upgradeBuildEditor .upgrade-piece-row[open]").count(),
    1,
    "exactly one piece editor may be open at a time",
  );
  const fieldLayout = await page.locator("#upgradeBuildEditor .upgrade-piece-fields")
    .first().evaluate(element => ({
      display: getComputedStyle(element).display,
      columns: getComputedStyle(element).gridTemplateColumns.split(" ").length,
      order: [...element.querySelectorAll(":scope > label.input-group")].map(label => ({
        cls: label.className,
        order: getComputedStyle(label).order,
        top: Math.round(label.getBoundingClientRect().top),
      })),
    }));
  assert.equal(fieldLayout.display, "grid");
  assert.equal(fieldLayout.columns, 3, "the piece editor must use a 3-column grid");
  const orderField = cls => Number(fieldLayout.order.find(entry => entry.cls.includes(cls))?.order);
  assert.deepEqual(
    [orderField("field-archetype"), orderField("field-tertiary"), orderField("field-mod-size")],
    [1, 2, 3],
    "row 1 must be archetype | tertiary | armor mod",
  );
  assert.deepEqual(
    [orderField("field-tuning"), orderField("field-tuning-from"), orderField("field-mod-stat")],
    [4, 5, 6],
    "row 2 must be tuning | tuning source | mod stat",
  );

  // Opening another piece closes the previous one. The `toggle` event is queued
  // as a task, so the assertion waits for the settled DOM instead of racing it.
  await page.locator("#upgradeBuildEditor .upgrade-piece-row summary").nth(2).click();
  await page.waitForFunction(() => {
    const open = document.querySelectorAll("#upgradeBuildEditor .upgrade-piece-row[open]");
    return open.length === 1 && open[0].dataset.index === "2";
  }, null, { timeout: 5000 });
  const openIndexes = await page.locator("#upgradeBuildEditor .upgrade-piece-row[open]")
    .evaluateAll(rows => rows.map(row => Number(row.dataset.index)));
  assert.deepEqual(openIndexes, [2], "expanding another piece must collapse the previous one");
  await page.locator("#upgradeBuildEditor .upgrade-piece-row[open] summary").click();
  await page.waitForFunction(() =>
    document.querySelectorAll("#upgradeBuildEditor .upgrade-piece-row[open]").length === 0,
  null, { timeout: 5000 });
  assert.equal(await page.locator("#upgradeBuildEditor .upgrade-piece-row[open]").count(), 0);
  await page.locator("#upgradeBuildEditor .upgrade-piece-row summary").first().click();

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

  await page.locator("#targetGrid input[id^=\"target_\"]").evaluateAll(elements => {
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
  const mobileModeControls = await page.locator(
    "#targetGrid .stat-mode-control",
  ).evaluateAll(elements => elements.map(element => Math.round(element.getBoundingClientRect().height)));
  assert.ok(
    mobileModeControls.every(height => height >= 44),
    "mobile target priority/rule controls should retain a 44px touch target: " +
      JSON.stringify(mobileModeControls),
  );
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

  await page.evaluate(() => {
    window.setCalculatorMode("solve");
    window.resetTargetStats();
  });
  await page.locator("#onlyPlus5Tuning").check();
  await page.evaluate(() => window.solve());
  await page.locator("#results.show").waitFor();
  // The two-column theoretical picker is gone: owned-armor and theoretical plans
  // share one list, which must stay a compact horizontal strip on phones.
  const mobileResultList = page.locator("#inventoryResults .inventory-result-list");
  await mobileResultList.waitFor({ state: "visible" });
  const mobileResultLayout = await mobileResultList.evaluate(element => ({
    flow: getComputedStyle(element).gridAutoFlow,
    overflowX: getComputedStyle(element).overflowX,
    right: element.getBoundingClientRect().right,
  }));
  assert.equal(
    mobileResultLayout.flow,
    "column",
    "390px should collapse the unified loadout picker into a single horizontal row",
  );
  assert.equal(
    mobileResultLayout.overflowX,
    "auto",
    "the narrow-viewport loadout picker should scroll horizontally",
  );
  assert.ok(
    mobileResultLayout.right <= 390 + 1,
    "the loadout picker should stay inside the 390px viewport: " +
      JSON.stringify(mobileResultLayout),
  );
  // The full constraint matrix is an input surface behind 编辑条件, not part of
  // the first screen; it must still be reachable and keyboard scrollable.
  assert.equal(
    await page.locator("#conditionsDrawer").isHidden(),
    true,
    "the constraint drawer should start collapsed",
  );
  await page.locator("#btnEditConditions").click();
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
