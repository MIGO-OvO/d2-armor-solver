// Fetch the Armor 3.0 armor item catalog (name / rarity / bucket / class, in
// zh-chs / zh-cht / en) from the Bungie Manifest and write it to
// src/core/armor-items.data.mjs for offline use by the solver.
//
// Usage:
//   $env:BUNGIE_API_KEY="<your key>"; node scripts/fetch-armor-item-data.mjs
//
// Strategy — Manifest global language table:
//   The Manifest index (GET /Destiny2/Manifest/) lists one complete
//   DestinyInventoryItemDefinition JSON per language under
//   jsonWorldComponentContentPaths. Downloading those three files reveals the
//   whole armor catalog (filtered by itemCategoryHashes) in 1 index request +
//   3 language downloads, each with trilingual names — no need to request
//   every hash three times.
//   Alternative that also works: fetch each hash individually with
//   ?lc=zh-chs / ?lc=zh-cht / ?lc=en (the per-hash endpoint). That costs
//   ~400+ hashes x 3 languages ≈ 1200 throttled requests, so we prefer the
//   global table. The per-hash path is kept as a fallback: armor-set members
//   whose itemCategoryHashes miss the armor categories are force-included by
//   an individual fetch per language.
//
// Bungie throttles anonymous traffic, so each request waits 350ms.

import { writeFile } from "node:fs/promises";
import { ARMOR_SETS } from "../src/core/armor-sets.data.mjs";

const API_KEY = process.env.BUNGIE_API_KEY;
if (!API_KEY) {
  console.error('请先设置 BUNGIE_API_KEY 环境变量（见 docs）。');
  process.exit(1);
}

const PLATFORM = "https://www.bungie.net/Platform";
const LANGS = ["zh-chs", "zh-cht", "en"];

// Armor 3.0 item category hashes: 20 Helmet, 21 Arms, 22 Chest, 23 Legs,
// 24 Class Item (their parent category is 49 "Armor").
const ARMOR_ITEM_CATEGORY_HASHES = new Set([20, 21, 22, 23, 24]);

// inventory.tierType -> stable rarity id (language-neutral).
// 2 Common, 3 Uncommon, 4 Rare, 5 Legendary, 6 Exotic.
const TIER_TYPE_TO_RARITY = { 2: "common", 3: "uncommon", 4: "rare", 5: "legendary", 6: "exotic" };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// raw=true: Manifest content files (jsonWorldComponentContentPaths) are bare
// JSON objects — top level is already the hash->definition map — with no
// Bungie ErrorCode/Response wrapper, so skip the API envelope check for them.
async function getJson(url, { raw = false } = {}) {
  const res = await fetch(url, { headers: { "X-API-Key": API_KEY } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const json = await res.json();
  if (!raw) {
    if (json.ErrorCode !== 1) throw new Error(`${url}: ${json.ErrorStatus} ${json.Message || ''}`);
    return json.Response;
  }
  return json;
}

// Per-hash fallback: one request per language (?lc= selects the language).
async function fetchItemByLang(hash, lang) {
  const item = await getJson(
    `${PLATFORM}/Destiny2/Manifest/DestinyInventoryItemDefinition/${hash}/?lc=${lang}`,
  );
  await sleep(350);
  return item;
}

function isArmor(item) {
  return (item.itemCategoryHashes || []).some(cat => ARMOR_ITEM_CATEGORY_HASHES.has(cat));
}

function extract(item) {
  return {
    hash: item.hash,
    rarity: TIER_TYPE_TO_RARITY[item.inventory?.tierType] || String(item.inventory?.tierTypeName || ''),
    bucketHash: item.inventory?.bucketTypeHash ?? null,
    classType: item.classType ?? 3,
  };
}

function nameKey(lang) {
  return lang === 'zh-chs' ? 'zh' : lang === 'zh-cht' ? 'zhCht' : 'en';
}

async function main() {
  // 1. Manifest index — resolve the per-language component file paths.
  const manifest = await getJson(`${PLATFORM}/Destiny2/Manifest/`);
  await sleep(350);
  const version = manifest.version;
  const componentPaths = manifest.jsonWorldComponentContentPaths;

  // 2. Download each language's full item definition component and keep only
  //    armor items (itemCategoryHashes contains one of the armor categories).
  const perLang = {};
  for (const lang of LANGS) {
    const componentPath = componentPaths?.[lang]?.DestinyInventoryItemDefinition;
    if (!componentPath) throw new Error(`${lang}: Manifest 缺少 DestinyInventoryItemDefinition 组件路径`);
    const component = await getJson(`https://www.bungie.net${componentPath}`, { raw: true });
    await sleep(350);
    const armor = new Map();
    for (const [hash, def] of Object.entries(component)) {
      if (isArmor(def)) armor.set(Number(hash), def);
    }
    perLang[lang] = armor;
    console.error(`${lang}: 目录含 ${armor.size} 件护甲物品`);
  }

  // 3. Union: every catalogued armor item + every armor-set member hash
  //    (force-included even if category filtering missed it).
  const hashes = new Set();
  for (const armor of Object.values(perLang)) for (const hash of armor.keys()) hashes.add(hash);
  for (const set of ARMOR_SETS) for (const hash of set.items) hashes.add(hash);

  const armorItems = [];
  const needFallback = [];
  for (const hash of [...hashes].sort((a, b) => a - b)) {
    const name = { zh: '', zhCht: '', en: '' };
    let def = null;
    for (const lang of LANGS) {
      const d = perLang[lang].get(hash);
      if (d) {
        name[nameKey(lang)] = d.displayProperties?.name ?? '';
        def = def || d;
      }
    }
    if (!def) { needFallback.push(hash); continue; }
    armorItems.push({ ...extract(def), name });
  }

  // 4. Force-include armor-set members the category filter missed.
  if (needFallback.length) {
    console.error(`套装成员 ${needFallback.length} 件未命中类目过滤，逐 hash 抓取…`);
  }
  for (const hash of needFallback) {
    const name = { zh: '', zhCht: '', en: '' };
    let def = null;
    for (const lang of LANGS) {
      const d = await fetchItemByLang(hash, lang);
      name[nameKey(lang)] = d.displayProperties?.name ?? '';
      def = def || d;
    }
    armorItems.push({ ...extract(def), name });
  }
  armorItems.sort((a, b) => a.hash - b.hash);

  // 5. Write src/core/armor-items.data.mjs (style mirrors armor-sets.data.mjs).
  const today = new Date().toISOString().slice(0, 10);
  const content = [
    `// Generated from the Bungie Manifest, version ${version}.`,
    `// Sources: DestinyInventoryItemDefinition (zh-chs / zh-cht / en), downloaded ${today}.`,
    '// Item pages on light.gg: https://light.gg/db/items/<itemHash>/',
    `export const ARMOR_ITEMS_MANIFEST_VERSION = ${JSON.stringify(version)};`,
    `export const ARMOR_ITEMS = [${armorItems.map(item => JSON.stringify(item)).join(',')}];`,
    '',
  ].join('\n');
  const outUrl = new URL('../src/core/armor-items.data.mjs', import.meta.url);
  await writeFile(outUrl, content, 'utf8');
  console.error(`\n完成：Armor items written: ${armorItems.length}`);
}

main().catch(error => {
  console.error(`抓取失败：${error}`);
  process.exit(1);
});
