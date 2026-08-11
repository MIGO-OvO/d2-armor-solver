import assert from "node:assert/strict";
import test from "node:test";
import {
  MOCK_GUARDIAN_NAME,
  sanitizeProfileFixture,
} from "../scripts/capture-profile-fixture.mjs";

// Sanitizer unit tests (T7 tooling). The synthetic payload mirrors the real
// GetProfile shape (full envelope, itemComponents keyed by instanceId) with
// realistic 19-digit ids. When a real tests/fixtures/profile-fixture.json
// lands, these same properties are what the fixture must satisfy.
// The live capture flow (scripts/capture-profile-fixture.mjs) fetches
// memberships from /User/GetMembershipsForCurrentUser/ (User controller, not
// Destiny2) — verified against the real API 2026-08-09; the URL itself is
// covered by the real capture, not by these pure-function sanitize tests.
const INSTANCE_A = "6917529027641081856";
const INSTANCE_B = "6917529027641081861";
const CHARACTER = "2305843009471208001";
const MEMBERSHIP = "4611686018470000000";

const RAW = {
  ErrorCode: 1,
  Response: {
    data: {
      profile: {
        data: {
          userInfo: {
            membershipType: 3,
            membershipId: MEMBERSHIP,
            crossSaveOverride: 0,
            displayName: "Real Guardian",
            bungieGlobalDisplayName: "Real Guardian",
          },
        },
      },
      profileInventory: {
        data: {
          items: [
            { itemHash: 656307180, itemInstanceId: INSTANCE_A, quantity: 1, bucketHash: 3448274439 },
            { itemHash: 9000000001, itemInstanceId: INSTANCE_B, quantity: 1, bucketHash: 2465295065 },
          ],
        },
      },
      characters: {
        data: {
          [CHARACTER]: { characterId: CHARACTER, classType: 1, light: 2020 },
        },
      },
      characterInventories: {
        data: {
          [CHARACTER]: {
            items: [{ itemHash: 99093622, itemInstanceId: INSTANCE_A, quantity: 1, bucketHash: 3448274439 }],
          },
        },
      },
      characterEquipment: {
        data: {
          [CHARACTER]: {
            items: [{ itemHash: 2809120022, itemInstanceId: INSTANCE_A, quantity: 1, bucketHash: 1585787867 }],
          },
        },
      },
      // Real GetProfile also returns characterPlugSets (added when the real
      // fixture landed: keys are characterIds and must be masked like the
      // other character maps, not leaked as raw 19-digit ids).
      characterPlugSets: {
        data: {
          [CHARACTER]: {
            plugs: { "88": [{ plugItemHash: 1399216, canInsert: true, enabled: true }] },
          },
        },
      },
      itemComponents: {
        instances: {
          data: {
            [INSTANCE_A]: {
              energyCapacity: { energyCapacity: 10, energyUsed: 0, energyUnused: 10 },
              primaryStat: { statHash: 1935470627, value: 2020 },
              stats: {
                "2996146975": 30,
                "392767087": 10,
                "1943323491": 10,
                "1735777505": 20,
                "144602215": 25,
                "4244567218": 10,
              },
            },
            [INSTANCE_B]: { stats: {} },
          },
        },
        sockets: {
          data: {
            [INSTANCE_A]: {
              sockets: [
                { plugHash: 4183296050, isEnabled: true, isVisible: true },
                { plugHash: 0, isEnabled: false, isVisible: true },
              ],
            },
          },
        },
        plugStates: {
          data: {
            [INSTANCE_A]: { plugs: [{ plugHash: 4183296050, plugObjectives: [] }] },
          },
        },
      },
    },
  },
};

const sanitized = sanitizeProfileFixture(RAW);
const data = sanitized.Response.data;

test("instance ids become sequential string placeholders, identical across items and component maps", () => {
  const vaultItem = data.profileInventory.data.items[0];
  const placeholderA = vaultItem.itemInstanceId;
  assert.equal(typeof placeholderA, "string");
  assert.match(placeholderA, /^1000000000000000\d{3}$/);

  const inventoryKey = Object.keys(data.characterInventories.data)[0];
  const equipmentKey = Object.keys(data.characterEquipment.data)[0];
  // The same instance appears in the vault, character inventory and equipped
  // gear: every copy must map to the same placeholder (T9 dedup depends on it).
  assert.equal(data.characterInventories.data[inventoryKey].items[0].itemInstanceId, placeholderA);
  assert.equal(data.characterEquipment.data[equipmentKey].items[0].itemInstanceId, placeholderA);
  // itemComponents maps are keyed by the same placeholder.
  const instanceKeys = Object.keys(data.itemComponents.instances.data);
  assert.deepEqual(instanceKeys.sort(), [placeholderA, data.profileInventory.data.items[1].itemInstanceId].sort());
  assert.ok(data.itemComponents.sockets.data[placeholderA], "sockets keyed by placeholder");
  assert.ok(data.itemComponents.plugStates.data[placeholderA], "plugStates keyed by placeholder");
  // Distinct instances get distinct placeholders.
  assert.notEqual(data.profileInventory.data.items[1].itemInstanceId, placeholderA);
});

test("displayName and bungieGlobalDisplayName are replaced with MockGuardian", () => {
  assert.equal(data.profile.data.userInfo.displayName, MOCK_GUARDIAN_NAME);
  assert.equal(data.profile.data.userInfo.bungieGlobalDisplayName, MOCK_GUARDIAN_NAME);
  assert.ok(!JSON.stringify(sanitized).includes("Real Guardian"));
});

test("membershipId and character ids are masked, length preserved, originals gone", () => {
  const membershipId = data.profile.data.userInfo.membershipId;
  assert.equal(typeof membershipId, "string");
  assert.match(membershipId, /^\d+$/);
  assert.equal(membershipId.length, MEMBERSHIP.length);
  assert.notEqual(membershipId, MEMBERSHIP);

  const characterKey = Object.keys(data.characters.data)[0];
  assert.match(characterKey, /^\d+$/);
  assert.equal(characterKey.length, CHARACTER.length);
  assert.notEqual(characterKey, CHARACTER);
  // Map key and characterId value stay consistent.
  assert.equal(data.characters.data[characterKey].characterId, characterKey);
  assert.equal(Object.keys(data.characterInventories.data)[0], characterKey);
  assert.equal(Object.keys(data.characterEquipment.data)[0], characterKey);
  // characterPlugSets is keyed by the same masked characterId (real-fixture
  // regression: it used to leak the raw 19-digit character id).
  assert.equal(Object.keys(data.characterPlugSets.data)[0], characterKey);

  const json = JSON.stringify(sanitized);
  for (const secret of [INSTANCE_A, INSTANCE_B, CHARACTER, MEMBERSHIP]) {
    assert.ok(!json.includes(secret), `original id ${secret} must not leak`);
  }
});

test("item hashes, stats, bucketHash, plugHash and all numbers are untouched", () => {
  const rawVaultItem = RAW.Response.data.profileInventory.data.items[0];
  const vaultItem = data.profileInventory.data.items[0];
  assert.equal(vaultItem.itemHash, rawVaultItem.itemHash, "itemHash untouched");
  assert.equal(vaultItem.bucketHash, rawVaultItem.bucketHash, "bucketHash untouched");
  assert.equal(vaultItem.quantity, 1);
  // Weapon rows pass through unchanged (bucketHash not armor; T9 filters them).
  assert.equal(data.profileInventory.data.items[1].itemHash, 9000000001);

  const placeholderA = vaultItem.itemInstanceId;
  const rawInstance = RAW.Response.data.itemComponents.instances.data[INSTANCE_A];
  assert.deepEqual(
    data.itemComponents.instances.data[placeholderA].stats,
    rawInstance.stats,
    "stat values untouched",
  );
  assert.deepEqual(
    data.itemComponents.instances.data[placeholderA].energyCapacity,
    rawInstance.energyCapacity,
  );
  assert.equal(data.itemComponents.instances.data[placeholderA].primaryStat.statHash, 1935470627);
  assert.equal(data.itemComponents.sockets.data[placeholderA].sockets[0].plugHash, 4183296050);
  assert.equal(data.itemComponents.plugStates.data[placeholderA].plugs[0].plugHash, 4183296050);
  assert.equal(data.profile.data.userInfo.membershipType, 3);
  assert.equal(data.profile.data.userInfo.crossSaveOverride, 0);
});

test("input response is not mutated", () => {
  const snapshot = JSON.stringify(RAW);
  sanitizeProfileFixture(RAW);
  assert.equal(JSON.stringify(RAW), snapshot);
});

test("empty profile response is handled", () => {
  const empty = { ErrorCode: 1, Response: { data: {} } };
  assert.deepEqual(sanitizeProfileFixture(empty), empty);
});
