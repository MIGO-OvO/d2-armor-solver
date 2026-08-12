import assert from "node:assert/strict";
import test from "node:test";

import {
  BALANCED_TUNING_MOD_HASH,
  STAT_MOD_HASHES,
  TUNING_MOD_HASH_BY_TUNING,
} from "../src/core/armor-mods.data.mjs";
import {
  CANDIDATE_STATE,
  SOCKET_ROLE,
  buildSocketCapabilities,
  classifySocketRole,
  deriveTuningStats,
  findEmptyPlugHash,
  findSocketByRole,
} from "../src/core/armor-sockets.mjs";

const tuningHash = (to, from) => Number(TUNING_MOD_HASH_BY_TUNING[`${to}:${from}`]);
const statHash = (stat, size) => Number(STAT_MOD_HASHES[stat][size]);
const ALL_TUNING = [
  BALANCED_TUNING_MOD_HASH,
  ...Object.values(TUNING_MOD_HASH_BY_TUNING).map(Number),
];

test("socket role is identified from candidate plugs without a manifest socket table", () => {
  assert.equal(classifySocketRole({ currentPlugHash: statHash("health", 10), candidatePlugHashes: null }), SOCKET_ROLE.STAT);
  assert.equal(classifySocketRole({ currentPlugHash: tuningHash("health", "weapons"), candidatePlugHashes: null }), SOCKET_ROLE.TUNING);
  assert.equal(classifySocketRole({ currentPlugHash: 0, candidatePlugHashes: new Set(ALL_TUNING) }), SOCKET_ROLE.TUNING);
  assert.equal(classifySocketRole({ currentPlugHash: 0, candidatePlugHashes: new Set([statHash("weapons", 5)]) }), SOCKET_ROLE.STAT);
  assert.equal(classifySocketRole({ currentPlugHash: 0, candidatePlugHashes: new Set([999999999]) }), SOCKET_ROLE.OTHER);
  assert.equal(classifySocketRole({ currentPlugHash: 123, candidatePlugHashes: null }), SOCKET_ROLE.OTHER);
});

test("reusable plugs resolve per instanceId + socketIndex into candidates", () => {
  const sockets = [
    { plugHash: 0, isEnabled: true, isVisible: true },
    { plugHash: tuningHash("health", "weapons"), isEnabled: true, isVisible: true },
  ];
  const reusablePlugs = {
    0: [{ plugItemHash: statHash("health", 5), canInsert: true, enabled: true },
        { plugItemHash: statHash("health", 10), canInsert: true, enabled: true },
        { plugItemHash: 4256667756, canInsert: true, enabled: true }], // empty placeholder
    1: ALL_TUNING.map(plugItemHash => ({ plugItemHash, canInsert: true, enabled: true })),
  };
  const capabilities = buildSocketCapabilities(sockets, reusablePlugs, null);
  assert.equal(capabilities[0].role, SOCKET_ROLE.STAT);
  assert.equal(capabilities[0].candidateState, CANDIDATE_STATE.KNOWN);
  assert.ok(capabilities[0].candidatePlugHashes.has(statHash("health", 10)));
  assert.equal(capabilities[0].emptyPlugHash, 4256667756, "the non-mod placeholder is the empty plug");
  assert.equal(capabilities[1].role, SOCKET_ROLE.TUNING);
  assert.equal(capabilities[1].candidateState, CANDIDATE_STATE.KNOWN);
  assert.equal(capabilities[1].emptyPlugHash, null, "every candidate is a known tuning mod");
});

test("missing reusable plugs leave candidate state unknown, never an empty known set", () => {
  const sockets = [{ plugHash: 0, isEnabled: true, isVisible: true }];
  const capabilities = buildSocketCapabilities(sockets, null, null);
  assert.equal(capabilities[0].candidateState, CANDIDATE_STATE.UNKNOWN);
  assert.equal(capabilities[0].candidatePlugHashes.size, 0);
  assert.equal(capabilities[0].role, SOCKET_ROLE.OTHER, "no role can be claimed without evidence");
  // A partial reusable map must not turn the missing socket into "known empty".
  const partial = buildSocketCapabilities(sockets, {}, null);
  assert.equal(partial[0].candidateState, CANDIDATE_STATE.UNKNOWN);
});

test("the currently installed plug is always a legal candidate", () => {
  const sockets = [{ plugHash: statHash("weapons", 10), isEnabled: true, isVisible: true }];
  const capabilities = buildSocketCapabilities(sockets, null, null);
  assert.equal(capabilities[0].role, SOCKET_ROLE.STAT);
  assert.ok(capabilities[0].candidatePlugHashes.has(statHash("weapons", 10)));
});

test("known reusable plugs survive an absent plug-set response (never emptied)", () => {
  const sockets = [{ plugHash: 0, isEnabled: true, isVisible: true }];
  const reusablePlugs = { 0: [{ plugItemHash: statHash("melee", 5), canInsert: true, enabled: true }] };
  const capabilities = buildSocketCapabilities(sockets, reusablePlugs, new Set());
  assert.equal(capabilities[0].candidateState, CANDIDATE_STATE.KNOWN);
  assert.ok(
    capabilities[0].candidatePlugHashes.has(statHash("melee", 5)),
    "an empty plug-set response is unknown data, not proof the plug is absent",
  );
});

test("findSocketByRole never falls back to a guessed index", () => {
  assert.equal(findSocketByRole([], SOCKET_ROLE.STAT), null);
  assert.equal(findSocketByRole([{ socketIndex: 0, role: SOCKET_ROLE.OTHER }], SOCKET_ROLE.STAT), null);
  assert.equal(
    findSocketByRole([
      { socketIndex: 0, role: SOCKET_ROLE.OTHER },
      { socketIndex: 1, role: SOCKET_ROLE.STAT, enabled: true },
    ], SOCKET_ROLE.STAT).socketIndex,
    1,
  );
});

test("a legendary tuning socket with one destination derives its fixed tuning stat", () => {
  const candidates = new Set([
    BALANCED_TUNING_MOD_HASH,
    tuningHash("health", "weapons"),
    tuningHash("health", "super"),
    tuningHash("health", "grenade"),
  ]);
  const info = deriveTuningStats({
    candidatePlugHashes: candidates,
    candidateState: CANDIDATE_STATE.KNOWN,
  });
  assert.deepEqual(info, { fixedTuningStat: "health", allowedTuningStats: ["health"], confidence: "exact" });
});

test("an exotic tuning socket with many destinations is not locked to one stat", () => {
  const candidates = new Set(ALL_TUNING);
  const info = deriveTuningStats({
    candidatePlugHashes: candidates,
    candidateState: CANDIDATE_STATE.KNOWN,
  });
  assert.equal(info.fixedTuningStat, null);
  assert.deepEqual(
    [...info.allowedTuningStats].sort(),
    ["class", "grenade", "health", "melee", "super", "weapons"],
  );
  assert.equal(info.confidence, "exact");
});

test("unknown tuning data yields no fixed stat and no allowed set", () => {
  const info = deriveTuningStats({
    candidatePlugHashes: new Set(),
    candidateState: CANDIDATE_STATE.UNKNOWN,
  });
  assert.deepEqual(info, { fixedTuningStat: null, allowedTuningStats: null, confidence: "unknown" });
  assert.deepEqual(deriveTuningStats(null), { fixedTuningStat: null, allowedTuningStats: null, confidence: "unknown" });
});

test("balanced-only tuning socket is exactly known but has no directional tuning", () => {
  const info = deriveTuningStats({
    candidatePlugHashes: new Set([BALANCED_TUNING_MOD_HASH]),
    candidateState: CANDIDATE_STATE.KNOWN,
  });
  assert.deepEqual(info, { fixedTuningStat: null, allowedTuningStats: [], confidence: "exact" });
});

test("findEmptyPlugHash picks the non-mod candidate from the socket list", () => {
  assert.equal(findEmptyPlugHash(new Set([statHash("health", 10), 4256667756])), 4256667756);
  assert.equal(findEmptyPlugHash(new Set([statHash("health", 10)])), null);
  assert.equal(findEmptyPlugHash(null), null);
});
