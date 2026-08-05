import { ARMOR_SETS } from "./armor-sets.data.mjs";

const SET_BY_ITEM_HASH = new Map();
for (const set of ARMOR_SETS) {
  for (const itemHash of set.items) {
    SET_BY_ITEM_HASH.set(itemHash, set);
  }
}

// App language keys are 'zh-chs' / 'zh-cht' / 'en'; data uses 'zh' / 'zhCht'.
const DATA_LANGUAGE_BY_PAGE_LANGUAGE = {
  'zh-chs': 'zh',
  'zh-cht': 'zhCht',
  en: 'en',
};

export function getArmorSetByItemHash(itemHash) {
  return SET_BY_ITEM_HASH.get(Number(itemHash)) || null;
}

export function getArmorSetByHash(setHash) {
  return ARMOR_SETS.find(set => set.hash === Number(setHash)) || null;
}

export function getSetName(set, language = 'zh-chs') {
  const key = DATA_LANGUAGE_BY_PAGE_LANGUAGE[language] || 'zh';
  return set?.name?.[key] || set?.name?.zh || '';
}

export function getSetBonusText(bonus, language = 'zh-chs') {
  const key = DATA_LANGUAGE_BY_PAGE_LANGUAGE[language] || 'zh';
  const text = bonus?.[key];
  return { name: text?.name || '', desc: text?.desc || '' };
}

// Count owned pieces per set for a list of item hashes (sets absent are skipped).
export function getSetPieceCounts(itemHashes) {
  const counts = new Map();
  for (const itemHash of itemHashes) {
    const set = getArmorSetByItemHash(itemHash);
    if (!set) continue;
    counts.set(set, (counts.get(set) || 0) + 1);
  }
  return counts;
}

// Active set bonuses for a list of item hashes, ordered 4pc before 2pc.
export function getActiveSetBonuses(itemHashes, language = 'zh-chs') {
  const active = [];
  for (const [set, count] of getSetPieceCounts(itemHashes)) {
    for (const bonus of set.bonuses) {
      if (count >= bonus.count) {
        active.push({
          set,
          pieceCount: count,
          requiredCount: bonus.count,
          ...getSetBonusText(bonus, language),
        });
      }
    }
  }
  return active.sort((a, b) => b.requiredCount - a.requiredCount);
}

export function listArmorSets() {
  return ARMOR_SETS;
}
