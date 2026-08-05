// Fetch the exact investment stats of the Armor 3.0 stat mods and tuning
// mods from the Bungie Manifest, so the DIM export can write the precise
// (+5 destination, -5 source) of each tuning mod.
//
// Usage:
//   $env:BUNGIE_API_KEY="<your key>"; node scripts/fetch-armor-mod-data.mjs
//
// Output: one JSON object per item — { hash, name, stats: [{stat, value, conditional}] }
// Bungie throttles anonymous traffic, so each request waits 350ms.

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

// Directional +5/-5 tuning mods (from DIM's tuningModToTunedStathash)
const TUNING_MOD_HASHES = [
  309000506, 311164277, 323635379, 388618952, 455024236, 534630542, 673231129,
  691392383, 891771298, 957763733, 1510949672, 1672416975, 1879022254, 1918710127,
  1922571986, 2125798995, 2244422610, 3121760799, 3284443097, 3310526732, 3554800389,
  3681082702, 3946669007, 4020349587, 4026414261, 4030660414, 4088823605, 4116389173,
  4164883102, 4210715468,
];

// The +5/+10 stat mods currently written into exports (verify they still exist)
const STAT_MOD_HASHES = [
  1703647492, 4183296050, 2532323436, 1180408010, 1237786518, 4204488676,
  4021790309, 1435557120, 350061697, 2724608735, 2639422088, 4287799666,
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchItem(hash) {
  const res = await fetch(
    `https://www.bungie.net/Platform/Destiny2/Manifest/DestinyInventoryItemDefinition/${hash}/`,
    { headers: { 'X-API-Key': API_KEY } },
  );
  if (!res.ok) throw new Error(`${hash}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.ErrorCode !== 1) throw new Error(`${hash}: ${json.ErrorStatus} ${json.Message || ''}`);
  return json.Response;
}

const all = [...TUNING_MOD_HASHES, ...STAT_MOD_HASHES];
for (let i = 0; i < all.length; i++) {
  const hash = all[i];
  try {
    const item = await fetchItem(hash);
    const stats = (item.investmentStats || []).map(s => ({
      stat: STAT_HASH_TO_NAME[s.statTypeHash] || String(s.statTypeHash),
      value: s.value,
      conditional: Boolean(s.isConditionallyActive),
    }));
    console.log(JSON.stringify({ hash, name: item.displayProperties?.name, stats }));
  } catch (error) {
    console.log(JSON.stringify({ hash, error: String(error) }));
  }
  await sleep(350);
}
console.error(`\n完成：共查询 ${all.length} 个物品定义。`);
