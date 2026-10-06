import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {ARMOR_BUCKETS, VAULT_BUCKET, extractStorage, planSpace, checkVaultSpace} from '../src/core/bungie-storage.mjs';
import {buildArmorInventory} from '../src/core/bungie-inventory.mjs';
import {buildCustomLoadoutPlan, applyCustomLoadoutPlan, reconcileCustomLoadout, extractBungieLoadoutState} from '../src/core/bungie-loadout.mjs';
import {bungieImage, renderCharacterCards, renderBungieTask} from '../src/core/bungie-task-view.mjs';
import {saveToken} from '../src/core/bungie-api.mjs';

const armor = (id, slot = 'helmet', owner = 'Vault') => ({id, hash: 123, slot, owner, classId: 'hunter', transferStatus: 0, equipped: false});
const makePlan = (items, extra = {}) => buildCustomLoadoutPlan({membershipType: 3, membershipId: 'member',
  targetCharacterId: 'target', classId: 'hunter', inventory: items,
  pieces: items.map(item => ({...item, sourceId: item.id})), mode: 'collect', ...extra});
const response = body => ({ok: true, status: 200, json: async () => ({ErrorCode: 1, Response: body})});
const raw = item => ({itemInstanceId: item.id, itemHash: item.hash, bucketHash: ARMOR_BUCKETS[item.slot], transferStatus: 0});
const snapshot = (items, equipped = false) => ({characters: {data: {target: {classType: 1}}},
  characterInventories: {data: {target: {items: equipped ? [] : items.map(raw)}}},
  characterEquipment: {data: {target: {items: equipped ? items.map(raw) : []}}}, profileInventory: {data: {items: []}}});

async function mockApi(fn, action) {
  const originalFetch = globalThis.fetch, originalStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.__BUNGIE_API_KEY__ = 'test';
  globalThis.__BUNGIE_OAUTH_CLIENT_ID__ = 'test';
  globalThis.localStorage = {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)};
  saveToken({accessToken: 'fake', refreshToken: 'fake', expiresIn: 3600, obtainedAt: Date.now()});
  globalThis.fetch = fn;
  try { return await action(); }
  finally { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; }
}

test('mixed weapon and armor buckets do not fill an empty helmet bucket', () => {
  const backpack = Array.from({length: 100}, (_, index) => ({itemInstanceId: String(index), itemHash: 42, bucketHash: 1498876634, transferStatus: 0}));
  const plan = makePlan([armor('incoming')], {targetCharacterInventory: backpack});
  assert.equal(plan.valid, true);
  assert.equal(plan.moveAsideTransfers.length, 0);
});

test('only the incoming bucket is freed; protected and non-transferable pieces stay put', () => {
  const backpack = Array.from({length: 9}, (_, index) => ({itemInstanceId: String(index), itemHash: 42, bucketHash: ARMOR_BUCKETS.helmet, transferStatus: index === 0 ? 2 : 0}));
  const result = planSpace({incoming: [armor('new')], inventory: [], backpack, characterId: 'target', membershipType: 3, protectedIds: new Set(['1'])});
  assert.equal(result.transfers.length, 1);
  assert.equal(result.transfers[0].itemId, '2');
  assert.equal(result.errors.length, 0);
  for (const item of backpack) item.transferStatus = 2;
  assert.equal(planSpace({incoming: [armor('new')], inventory: [], backpack, characterId: 'target', membershipType: 3}).errors[0].code, 'inventoryFull');
});

test('vault capacity checks peak occupancy and intermediate hops', () => {
  const plan = {moveAsideTransfers: [], preparationTransfers: [], transfers: [
    {itemId: 'incoming', transferToVault: true}, {itemId: 'incoming', transferToVault: false}]};
  assert.equal(checkVaultSpace(plan, {vaultItems: [{itemInstanceId: 'existing'}], vaultCapacity: 1})[0].code, 'vaultFull');
  assert.deepEqual(checkVaultSpace(plan, {vaultItems: [], vaultCapacity: 1}), []);
  assert.deepEqual(checkVaultSpace(plan, {vaultItems: [], vaultCapacity: null}), []);
});

test('raw storage retains bucket/transfer eligibility, including vault occupancy', () => {
  const data = snapshot([armor('one')]);
  data.profileInventory.data.items = [{itemInstanceId: 'v', itemHash: 5, bucketHash: VAULT_BUCKET}, {itemHash: 6, bucketHash: 999}];
  const storage = extractStorage(data);
  assert.equal(storage.characterInventories.target[0].bucketHash, ARMOR_BUCKETS.helmet);
  assert.equal(storage.characterInventories.target[0].transferStatus, 0);
  assert.equal(storage.vaultItems.length, 1);
});

test('real fixture keeps bucket identity rather than flattening all carried gear', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/profile-fixture.json', import.meta.url)));
  const mapped = buildArmorInventory(fixture);
  for (const backpack of Object.values(mapped.characterInventories)) {
    assert.ok(backpack.length > 10);
    assert.ok(new Set(backpack.map(item => item.bucketHash)).size > 5);
    assert.ok(backpack.every(item => item.transferStatus !== undefined));
  }
  const characters = Object.values(extractBungieLoadoutState(fixture).characters);
  assert.ok(characters.every(character => character.emblemBackgroundPath && character.titleRecordHash));
});

test('partial collect and armor-only equip do not depend on mod/socket proof', () => {
  const items = [armor('one'), armor('two', 'arms')];
  for (const mode of ['collect', 'equip']) {
    const plan = makePlan(items, {mode});
    assert.equal(plan.valid, true, JSON.stringify(plan.errors));
    assert.equal(plan.plugOperations.length, 0);
  }
  assert.equal(makePlan(items, {mode: 'full'}).valid, false);
  assert.equal(makePlan(items, {mode: 'invalid'}).valid, false);
  assert.equal(makePlan([items[0], items[0]]).valid, false);
});

test('missing instances and wrong hashes never become writable fallback items', () => {
  const item = armor('one');
  assert.equal(makePlan([item], {pieces: [{...item, sourceId: 'missing'}]}).valid, false);
  assert.equal(makePlan([item], {pieces: [{...item, hash: 456, sourceId: item.id}]}).valid, false);
});

test('exotic equip limits use the actual inventory, not stale plan flags', () => {
  const items = [{...armor('one'), exotic: true}, {...armor('two', 'arms'), exotic: true}];
  const pieces = items.map(item => ({...item, sourceId: item.id, exotic: false}));
  assert.ok(makePlan(items, {pieces, mode: 'equip'}).errors.some(error => error.code === 'multipleExotics'));
  assert.equal(makePlan(items, {pieces, mode: 'collect'}).valid, true);
});

test('source replacement also checks space on the source character', () => {
  const item = {...armor('one', 'helmet', 'source'), equipped: true};
  const spare = armor('spare');
  const backpack = Array.from({length: 9}, (_, index) => ({itemInstanceId: `s${index}`, itemHash: 42, bucketHash: ARMOR_BUCKETS.helmet, transferStatus: 0}));
  const plan = makePlan([item], {inventory: [item, spare], storage: {characterInventories: {source: backpack}}});
  assert.equal(plan.valid, true, JSON.stringify(plan.errors));
  assert.equal(plan.moveAsideTransfers[0].characterId, 'source');
  assert.equal(plan.preparationTransfers[0].itemId, 'spare');
});

test('collect emits per-item route events and never equips or inserts mods', async () => {
  const items = [armor('one')], calls = [], events = [];
  await mockApi(async (url, options) => {
    calls.push({url, options});
    return response(options.method === 'GET' ? snapshot(items) : {});
  }, async () => {
    const result = await applyCustomLoadoutPlan(makePlan(items), {delays: false, onProgress: event => events.push(event)});
    assert.equal(result.verification.status, 'verified');
  });
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.ok(!calls.some(call => /EquipItems|InsertSocket/.test(call.url)));
  assert.ok(events.some(event => event.itemId === 'one' && event.from === 'Vault' && event.to === 'target' && event.state === 'running'));
  assert.ok(events.some(event => event.itemId === 'one' && event.state === 'succeeded'));
  assert.equal(events.at(-1).stage, 'verify');
});

test('a failed first transfer hop prunes its second hop but not independent armor', async () => {
  const items = [armor('one', 'helmet', 'source'), armor('two', 'arms')];
  const writes = [];
  await mockApi(async (_url, options) => {
    const body = JSON.parse(options.body); writes.push(body);
    if (body.itemId === 'one') return {ok: true, status: 200, json: async () => ({ErrorCode: 1655})};
    return response({});
  }, async () => {
    const result = await applyCustomLoadoutPlan(makePlan(items), {delays: false, verify: false});
    assert.equal(result.transferFailures.length, 1);
  });
  assert.equal(writes.filter(write => write.itemId === 'one').length, 1);
  assert.equal(writes.filter(write => write.itemId === 'two').length, 1);
});

test('stop cancels only future writes and performs a reconciliation', async () => {
  const items = [armor('one'), armor('two', 'arms')];
  let writes = 0, reads = 0;
  await mockApi(async (_url, options) => {
    if (options.method === 'GET') { reads++; return response(snapshot([items[0]])); }
    writes++; return response({});
  }, async () => {
    await assert.rejects(applyCustomLoadoutPlan(makePlan(items), {delays: false, shouldStop: () => writes === 1}), error => {
      assert.equal(error.stopped, true);
      assert.equal(error.reconciliation.itemStates[0].arrived, true);
      return true;
    });
  });
  assert.equal(writes, 1); assert.ok(reads > 0);
});

test('a timeout after a successful write is read back, never replayed', async () => {
  const items = [armor('one')]; let writes = 0;
  await mockApi(async (_url, options) => {
    if (options.method === 'GET') return response(snapshot(items));
    writes++; throw new Error('response lost');
  }, async () => {
    await assert.rejects(applyCustomLoadoutPlan(makePlan(items), {delays: false}), error => {
      assert.equal(error.reconciliation.status, 'verified'); return true;
    });
  });
  assert.equal(writes, 1);
});

test('fresh ownership replans remaining moves and already equipped armor is not re-equipped', async () => {
  const item = {...armor('one', 'helmet', 'target'), equipped: true};
  const plan = makePlan([item], {mode: 'equip'});
  assert.equal(plan.transfers.length, 0);
  await mockApi(async (_url, options) => {
    assert.equal(options.method, 'GET'); return response(snapshot([item], true));
  }, async () => assert.equal((await applyCustomLoadoutPlan(plan, {delays: false})).verification.status, 'verified'));
});

test('incomplete server data is unverified even if a write appeared successful', async () => {
  await mockApi(async () => response({}), async () => {
    const result = await reconcileCustomLoadout(makePlan([armor('one')]), {retries: 0});
    assert.equal(result.status, 'unverified');
  });
});

test('image paths are restricted and character cards expose radio semantics and incompatibility', () => {
  assert.equal(bungieImage('javascript:alert(1)'), '');
  assert.equal(bungieImage('/common/x\" onerror=x'), '');
  const html = renderCharacterCards({characters: [{characterId: 'target', classId: 'hunter', light: 529, emblemBackgroundPath: '/common/bg.jpg'},
    {characterId: 'other', classId: 'titan'}], selected: 'target', classId: 'hunter', l: (_a, _b, en) => en, classLabel: id => id});
  assert.match(html, /type="radio"/); assert.match(html, /checked/); assert.match(html, /Incompatible class/);
  assert.match(html, /https:\/\/www.bungie.net\/common\/bg.jpg/);
});

test('task view distinguishes confirmed armor from failed mods and escapes item names', () => {
  const item = {...armor('one'), name: '<img onerror=x>'};
  const html = renderBungieTask({target: 'target', mode: 'full', status: 'partial', plan: {items: [item]},
    verification: {itemStates: [{itemId: 'one', arrived: true, equipped: true}], plugs: [{itemId: 'one', verified: false}]}},
  {l: (_a, _b, en) => en, ownerLabel: id => id, itemLabel: id => id, imageFor: () => '', errorLabel: String});
  assert.match(html, /Armor equipped · mods pending/); assert.match(html, /&lt;img onerror=x&gt;/);
  assert.match(html, /Check again/); assert.match(html, /Review remaining actions/);
});
