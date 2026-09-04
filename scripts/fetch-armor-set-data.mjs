// Fetch the armor set-bonus catalog (DestinyEquipableItemSetDefinition +
// DestinySandboxPerkDefinition, zh-chs / zh-cht / en) from the official
// Bungie Manifest and write src/core/armor-sets.data.mjs for offline use.
//
// Usage:
//   node scripts/fetch-armor-set-data.mjs            # anonymous (works today)
//   $env:BUNGIE_API_KEY="<key>"; node scripts/fetch-armor-set-data.mjs
//
// The generated file keeps the solver schema (hash / name / items / bonuses)
// and additionally merges hand-curated metadata from scripts/armor-sets-meta.json
// (activity category, effect-group id, acquisition source, per-class armor
// family naming notes — sources: the 2026-08-26 spreadsheet audit + light.gg /
// GamesRef cross-checks). Set names, item hashes and perk texts always come
// from the official manifest; meta never overrides official text.
//
// Bungie throttles traffic, so each request waits 350ms.

import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

const API_KEY = process.env.BUNGIE_API_KEY || "";
const PLATFORM = "https://www.bungie.net/Platform";
const LANGS = ["zh-chs", "zh-cht", "en"];
const COMPONENTS = ["DestinyEquipableItemSetDefinition", "DestinySandboxPerkDefinition"];
const META_PATH = new URL("./armor-sets-meta.json", import.meta.url);
const OUT_PATH = new URL("../src/core/armor-sets.data.mjs", import.meta.url);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Manifest content files (jsonWorldComponentContentPaths) are bare JSON with
// no ErrorCode/Response envelope, hence `raw`.
async function getJson(url, { raw = false } = {}) {
  const headers = API_KEY ? { "X-API-Key": API_KEY } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const json = await res.json();
  if (!raw) {
    if (json.ErrorCode !== 1) throw new Error(`${url}: ${json.ErrorStatus} ${json.Message || ''}`);
    return json.Response;
  }
  return json;
}

function text(perks, hash) {
  const def = perks[hash];
  return {
    name: def?.displayProperties?.name ?? "",
    desc: def?.displayProperties?.description ?? "",
  };
}

async function main() {
  // 1. Manifest index -> version + per-language component paths.
  const manifest = await getJson(`${PLATFORM}/Destiny2/Manifest/`);
  await sleep(350);
  const version = manifest.version;
  const componentPaths = manifest.jsonWorldComponentContentPaths;

  // 2. Download the two components in all three languages.
  const data = {};
  for (const lang of LANGS) {
    for (const component of COMPONENTS) {
      const path = componentPaths?.[lang]?.[component];
      if (!path) throw new Error(`${lang}: manifest 缺少 ${component} 组件路径`);
      data[`${component}:${lang}`] = await getJson(`https://www.bungie.net${path}`, { raw: true });
      await sleep(350);
    }
  }

  // 3. Hand-curated metadata (category / groupId / source / classNotes).
  let meta = { sets: {} };
  if (existsSync(META_PATH)) {
    meta = JSON.parse(readFileSync(META_PATH, "utf8"));
  } else {
    console.error("警告：未找到 scripts/armor-sets-meta.json，只生成官方字段。");
  }

  // 4. Merge: official definitions drive everything; meta only decorates.
  const setDefs = {
    "zh-chs": data["DestinyEquipableItemSetDefinition:zh-chs"],
    "zh-cht": data["DestinyEquipableItemSetDefinition:zh-cht"],
    en: data["DestinyEquipableItemSetDefinition:en"],
  };
  const perkDefs = {
    "zh-chs": data["DestinySandboxPerkDefinition:zh-chs"],
    "zh-cht": data["DestinySandboxPerkDefinition:zh-cht"],
    en: data["DestinySandboxPerkDefinition:en"],
  };
  const nameOf = (lang, hash) =>
    setDefs[lang][hash]?.displayProperties?.name ?? "";
  const nameKey = lang => (lang === "zh-chs" ? "zh" : lang === "zh-cht" ? "zhCht" : "en");

  const missingMeta = [];
  const sets = [];
  for (const [hashStr, def] of Object.entries(setDefs.en)) {
    if (def.redacted || def.blacklisted) continue;
    const hash = Number(hashStr);
    const name = {};
    for (const lang of LANGS) name[nameKey(lang)] = nameOf(lang, hashStr);
    const bonuses = def.setPerks.map(perk => {
      const bonus = { count: perk.requiredSetCount };
      for (const lang of LANGS) {
        bonus[nameKey(lang)] = text(perkDefs[lang], perk.sandboxPerkHash);
      }
      return bonus;
    });
    const entry = {
      hash,
      name,
      items: def.setItems,
      bonuses,
    };
    const metaEntry = meta.sets[name.en];
    if (metaEntry) {
      entry.category = metaEntry.category;
      entry.groupId = metaEntry.groupId;
      entry.source = metaEntry.source;
      if (metaEntry.classNotes?.length) entry.classNotes = metaEntry.classNotes;
    } else {
      missingMeta.push(name.en);
    }
    sets.push(entry);
  }
  sets.sort((a, b) => a.hash - b.hash);

  const orphanMeta = Object.keys(meta.sets).filter(
    key => !sets.some(set => set.name.en === key),
  );
  if (missingMeta.length) {
    console.error(`警告：${missingMeta.length} 组套装在 meta 中没有条目（无分类/来源）：`);
    for (const key of missingMeta) console.error(`  - ${key}`);
  }
  if (orphanMeta.length) {
    throw new Error(`meta 中以下条目未命中官方 manifest（名称已变？）：\n  ${orphanMeta.join("\n  ")}`);
  }

  // 5. Write src/core/armor-sets.data.mjs (stable shape, one line per set).
  const today = new Date().toISOString().slice(0, 10);
  const categoryOrder = Array.isArray(meta.categoryOrder) && meta.categoryOrder.length
    ? meta.categoryOrder
    : null;
  const content = [
    "// Generated from the Bungie Manifest, version " + version + ".",
    "// Sources: DestinyEquipableItemSetDefinition and DestinySandboxPerkDefinition",
    "// (zh-chs / zh-cht / en), downloaded " + today + " via scripts/fetch-armor-set-data.mjs.",
    "// category / groupId / source / classNotes merge hand-curated metadata from",
    "// scripts/armor-sets-meta.json (spreadsheet audit 2026-08-26 + light.gg / GamesRef).",
    "// Item pages on light.gg: https://light.gg/db/items/<itemHash>/",
    `export const ARMOR_SETS_MANIFEST_VERSION = ${JSON.stringify(version)};`,
    ...(categoryOrder ? [`export const ARMOR_SET_CATEGORY_ORDER = ${JSON.stringify(categoryOrder)};`] : []),
    `export const ARMOR_SETS = [${sets.map(set => JSON.stringify(set)).join(",")}];`,
    "",
  ].join("\n");
  await writeFile(OUT_PATH, content, "utf8");
  console.error(`完成：套装组数 ${sets.length}，写入 ${new URL(OUT_PATH).pathname}`);
}

main().catch(error => {
  console.error(`抓取失败：${error}`);
  process.exit(1);
});
