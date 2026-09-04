import assert from "node:assert/strict";
import test from "node:test";

import {
  EXECUTION_STATUS,
  RESULT_STATUS,
  STAT_DOMAIN,
  attachResultCertificate,
  compareCanonicalCandidates,
  compareIntegerTuples,
  createCanonicalId,
  createConstraintModel,
  createPieceCapability,
  createProblemSpec,
  createResultCertificate,
  matchesExactTarget,
  satisfiesConstraintModel,
  visibleStatFromArmor,
} from "../src/core/solver-v3-contract.mjs";

test("Solver V3 exposes only the specified result and execution statuses", () => {
  assert.deepEqual(Object.values(RESULT_STATUS), [
    "EXACT_TARGET_PROVEN",
    "RULE_FEASIBLE_PROVEN",
    "INFEASIBLE_PROVEN",
    "SEARCH_LIMIT_REACHED",
    "INVALID_INPUT",
  ]);
  assert.deepEqual(Object.values(EXECUTION_STATUS), [
    "VERIFIED",
    "UNVERIFIED",
    "BLOCKED",
    "NOT_APPLICABLE",
  ]);
});

test("visible constraints translate into the unclamped armor domain", () => {
  const model = createConstraintModel({
    targetDomain: STAT_DOMAIN.VISIBLE,
    target: { health: 0, melee: 50, grenade: 200 },
    fragments: { health: -10, melee: 10, grenade: 20 },
    constraints: {
      exact: { health: true, melee: true, grenade: true },
    },
  });

  assert.equal(model.valid, true);
  assert.equal(model.domain, STAT_DOMAIN.ARMOR);
  const byStat = Object.fromEntries(model.rules.map(rule => [rule.stat, rule]));
  assert.equal(byStat.health.armorMinimum, null);
  assert.equal(byStat.health.armorMaximum, 10);
  assert.equal(byStat.melee.armorMinimum, 40);
  assert.equal(byStat.melee.armorMaximum, 40);
  assert.equal(byStat.grenade.armorMinimum, 180);
  assert.equal(byStat.grenade.armorMaximum, null);
  assert.equal(visibleStatFromArmor(205, 20), 200);
});

test("constraint checks keep armor and visible domains explicit", () => {
  const model = createConstraintModel({
    targetDomain: STAT_DOMAIN.VISIBLE,
    target: { health: 0, melee: 50, grenade: 200 },
    fragments: { health: -10, melee: 10, grenade: 20 },
    constraints: {
      exact: { health: true, melee: true, grenade: true },
    },
  });
  const armorWitness = { totals: {
    health: 5, melee: 40, grenade: 185, super: 0, class: 0, weapons: 0,
  } };
  const visibleWitness = { finalTotals: {
    health: 0, melee: 50, grenade: 200, super: 0, class: 0, weapons: 0,
  } };

  assert.equal(satisfiesConstraintModel(armorWitness, model, STAT_DOMAIN.ARMOR), true);
  assert.equal(satisfiesConstraintModel(visibleWitness, model, STAT_DOMAIN.VISIBLE), true);
  assert.equal(matchesExactTarget(visibleWitness, model, STAT_DOMAIN.VISIBLE), true);
  assert.equal(matchesExactTarget(armorWitness, model, STAT_DOMAIN.ARMOR), false,
    "clamped boundary targets describe ranges, not a fake armor-domain equality");
});

test("PieceCapability equivalence includes future-relevant execution state", () => {
  const common = {
    slot: "helmet",
    baseStats: { health: 30, melee: 25, grenade: 20, super: 5, class: 5, weapons: 5 },
    archetype: "brawler",
    tertiary: "grenade",
    setHash: 123,
    allowedTuningStats: ["health"],
    tuningConfidence: "exact",
    socketCapabilities: [{
      socketIndex: 2,
      role: "stat",
      candidateState: "known",
      candidatePlugHashes: new Set([20, 10]),
    }],
    energy: { capacity: 10, used: 5 },
  };
  const left = createPieceCapability(common, 0);
  const same = createPieceCapability({ ...common }, 0);
  const differentSet = createPieceCapability({ ...common, setHash: 456 }, 0);
  const differentSocket = createPieceCapability({
    ...common,
    socketCapabilities: [{
      ...common.socketCapabilities[0],
      candidatePlugHashes: new Set([10]),
    }],
  }, 0);

  assert.equal(left.equivalenceKey, same.equivalenceKey);
  assert.notEqual(left.equivalenceKey, differentSet.equivalenceKey);
  assert.notEqual(left.equivalenceKey, differentSocket.equivalenceKey);
  assert.equal(left.executionKnown, true);
});

test("ProblemSpec validates integer budgets and carries the same constraint model", () => {
  const valid = createProblemSpec({
    operation: "solve",
    target: { health: 50 },
    numPlus5: 2,
    numPlus10: 3,
    numPlus3: 1,
  });
  const invalid = createProblemSpec({ numPlus5: 2.5, numPlus10: 5 });

  assert.equal(valid.valid, true);
  assert.equal(valid.constraintModel.domain, STAT_DOMAIN.ARMOR);
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join("\n"), /numPlus5/);
});

test("canonical ordering uses integer tuples and a deterministic witness id", () => {
  assert.equal(compareIntegerTuples([0, 1, 20], [0, 2, 0]), -1);
  assert.throws(() => compareIntegerTuples([0.5], [1]), /safe integers/);

  const a = {
    rank: [0, 0],
    totals: { health: 1, melee: 2 },
    config: [{ archetype: "a", tertiary: "health", baseStats: {} }],
  };
  const b = {
    rank: [0, 0],
    totals: { health: 2, melee: 1 },
    config: [{ archetype: "b", tertiary: "health", baseStats: {} }],
  };
  assert.equal(createCanonicalId(a), createCanonicalId(structuredClone(a)));
  assert.notEqual(compareCanonicalCandidates(a, b), 0);
});

test("result certificates survive legacy array containers and structured clone", () => {
  const problemSpec = createProblemSpec({ operation: "solve", target: {} });
  const witness = {
    totals: { health: 0, melee: 0, grenade: 0, super: 0, class: 0, weapons: 0 },
    config: [],
  };
  const certificate = createResultCertificate({
    status: RESULT_STATUS.EXACT_TARGET_PROVEN,
    executionStatus: EXECUTION_STATUS.NOT_APPLICABLE,
    problemSpec,
    witness,
    proof: { method: "test-oracle", exhaustive: true },
  });
  const legacyResult = attachResultCertificate([witness], certificate);
  const cloned = structuredClone(legacyResult);

  assert.equal(cloned.length, 1);
  assert.equal(cloned.status, RESULT_STATUS.EXACT_TARGET_PROVEN);
  assert.equal(cloned.certificate.canonicalId, createCanonicalId(witness));
});
