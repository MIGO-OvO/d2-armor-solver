// Fetch the exact investment stats of all subclass Aspects and Fragments from
// the Bungie Manifest, so the app can map installed subclass socket plugs to
// the six-stat adjustments they grant (fragment auto-recognition).
//
// Usage:
//   $env:BUNGIE_API_KEY="<your key>"; node scripts/fetch-fragment-data.mjs
//
// Output: one JSON object per item — { hash, name, category, stats: [{stat, value}] }
// where category is "aspect" or "fragment". Bungie throttles anonymous
// traffic, so each request waits 350ms.
//
// The script discovers Aspect/Fragment hashes from the known subclass items
// (their sockets' reusable plugs), then verifies each definition's
// plugCategoryIdentifier and investmentStats.

const API_KEY = process.env.BUNGIE_API_KEY;
if (!API_KEY) {
  console.error('请先设置 BUNGIE_API_KEY 环境变量（见 docs）。');
  process.exit(1);
}

// Armor 3.0 stat hashes -> our stat ids (matches STATS in armor-model.mjs)
const STAT_HASH_TO_NAME = {
  2996146975: 'weapons',
  392767087: 'health',
  1943323491: 'class',
  1735777505: 'grenade',
  144602215: 'super',
  4244567218: 'melee',
};

// Equipped subclass item hashes (bucket 3284755031). Three verified from the
// real T7 fixture (tests/fixtures/profile-fixture.json): Titan 4282591831,
// Hunter 3893112950, Warlock 613647804. Add further subclass items here as
// they appear; the script only uses the listed ones to discover plug hashes.
const SUBCLASS_ITEM_HASHES = [
  4282591831, 3893112950, 613647804,
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'X-API-Key': API_KEY } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.ErrorCode !== 1) throw new Error(`${json.ErrorStatus} ${json.Message || ''}`);
  return json.Response;
}

async function fetchItem(hash) {
  return fetchJson(
    `https://www.bungie.net/Platform/Destiny2/Manifest/DestinyInventoryItemDefinition/${hash}/`
  );
}

// Collect every reusable plug hash across a subclass item's sockets, then
// classify each plug by its own definition's plugCategoryIdentifier.
async function collectSubclassPlugs(subclassItem) {
  const plugHashes = new Set();
  for (const socket of subclassItem.sockets?.socketEntries || []) {
    for (const plug of socket.reusablePlugItems || []) {
      if (plug.plugItemHash) plugHashes.add(plug.plugItemHash);
    }
    if (socket.singleInitialItemHash) plugHashes.add(socket.singleInitialItemHash);
  }
  const seen = new Map();
  for (const hash of plugHashes) {
    try {
      const item = await fetchItem(hash);
      const category = String(item.plug?.plugCategoryIdentifier || '');
      if (/aspect|fragment/i.test(category) && !seen.has(hash)) {
        seen.set(hash, { hash, name: item.displayProperties?.name, category });
      }
    } catch (error) {
      console.log(JSON.stringify({ hash, error: String(error) }));
    }
    await sleep(350);
  }
  return [...seen.values()];
}

const all = [];
const seenHashes = new Set();
for (const subclassHash of SUBCLASS_ITEM_HASHES) {
  try {
    const subclassItem = await fetchItem(subclassHash);
    const plugs = await collectSubclassPlugs(subclassItem);
    for (const plug of plugs) {
      if (seenHashes.has(plug.hash)) continue;
      seenHashes.add(plug.hash);
      try {
        const item = await fetchItem(plug.hash);
        const stats = (item.investmentStats || [])
          .filter(s => STAT_HASH_TO_NAME[s.statTypeHash])
          .map(s => ({ stat: STAT_HASH_TO_NAME[s.statTypeHash], value: s.value }));
        all.push({ ...plug, stats });
      } catch (error) {
        all.push({ ...plug, error: String(error) });
      }
      await sleep(350);
    }
  } catch (error) {
    console.log(JSON.stringify({ subclassHash, error: String(error) }));
  }
}

for (const entry of all) {
  console.log(JSON.stringify(entry));
}
console.error(`\n完成：共发现 ${all.length} 个 Aspect/Fragment 定义。`);
