// Catalog-backed synchronous adapter. Import this only when a profile must be
// mapped; lightweight constants/fragments live in bungie-inventory-model.
import {ARMOR_ITEMS} from './armor-items.data.mjs';
import {buildArmorInventory as mapInventory} from './bungie-inventory-model.mjs';
export * from './bungie-inventory-model.mjs';

export function buildArmorInventory(profileResponse, options = {}) {
  return mapInventory(profileResponse, {...options, catalogEntries: ARMOR_ITEMS});
}
