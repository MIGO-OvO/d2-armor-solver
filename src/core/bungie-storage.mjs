// Capacity is per equipment bucket, not per character. Bucket itemCount includes
// the equipped item: the five armor buckets have ten slots (nine backpack slots).
export const ARMOR_BUCKETS = {helmet: 3448274439, arms: 3551918588, chest: 14239492,
  legs: 20886954, classItem: 1585787867};
export const VAULT_BUCKET = 138197802;
export const idOf = item => String(item?.itemInstanceId ?? item?.id ?? '');
export const bucketOf = item => ARMOR_BUCKETS[item?.slot] || Number(item?.bucketHash) || 0;

export function inventoryEntry(item) {
  return {itemInstanceId: idOf(item), itemHash: Number(item?.itemHash ?? item?.hash) || 0,
    bucketHash: Number(item?.bucketHash) || ARMOR_BUCKETS[item?.slot] || 0,
    transferStatus: item?.transferStatus ?? null};
}

export function extractStorage(profile) {
  const root = profile?.Response ?? profile;
  const data = root?.data ?? root ?? {};
  return {
    characterInventories: Object.fromEntries(Object.entries(data.characterInventories?.data || {})
      .map(([id, component]) => [id, (component.items || []).map(inventoryEntry)])),
    vaultItems: (data.profileInventory?.data?.items || []).filter(item => Number(item.bucketHash) === VAULT_BUCKET).map(inventoryEntry),
    // Unknown capacity must never be invented from an old hard-coded vault size.
    vaultCapacity: null,
  };
}

export function planSpace({incoming, inventory, backpack, characterId, membershipType, protectedIds = new Set(), capacities = {}}) {
  const transfers = [], errors = [];
  if (!Array.isArray(backpack)) return {transfers, errors};
  const byId = new Map(inventory.map(item => [String(item.id), item]));
  const buckets = new Map();
  for (const item of incoming) {
    const bucket = bucketOf(item);
    if (bucket) buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
  }
  for (const [bucket, count] of buckets) {
    const carried = backpack.filter(item => (bucketOf(item) || bucketOf(byId.get(idOf(item)))) === bucket);
    const need = Math.max(0, carried.length + count - ((capacities[bucket] || 10) - 1));
    const candidates = carried.filter(item => idOf(item) && !protectedIds.has(idOf(item))
      && item.transferStatus != null && !(Number(item.transferStatus) & 3) && Number(item.itemHash));
    if (candidates.length < need) errors.push({code: 'inventoryFull', owner: characterId, bucketHash: bucket});
    for (const item of candidates.slice(0, need)) transfers.push({itemReferenceHash: Number(item.itemHash),
      stackSize: 1, transferToVault: true, itemId: idOf(item), characterId: String(characterId), membershipType: Number(membershipType)});
  }
  return {transfers, errors};
}

// Check peak vault occupancy in execution order, including temporary cross-
// character hops. No writes are made here; unknown capacity is surfaced by UI.
export function checkVaultSpace(plan, storage) {
  if (!Number.isFinite(storage?.vaultCapacity) || !Array.isArray(storage?.vaultItems)) return [];
  const ids = new Set(storage.vaultItems.map(idOf));
  let occupancy = storage.vaultItems.length;
  for (const request of [...plan.moveAsideTransfers, ...plan.preparationTransfers, ...plan.transfers]) {
    if (request.transferToVault && !ids.has(request.itemId)) {
      ids.add(request.itemId);
      if (++occupancy > storage.vaultCapacity) return [{code: 'vaultFull'}];
    } else if (!request.transferToVault && ids.delete(request.itemId)) occupancy--;
  }
  return [];
}
