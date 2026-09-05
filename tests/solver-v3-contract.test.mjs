import assert from "node:assert/strict";
import test from "node:test";
import { BASE_CONFIGS, STATS } from "../src/core/armor-model.mjs";

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
  createProofEvidence,
  createRulesetId,
  createResultCertificate,
  getArmorSolverInput,
  matchesExactTarget,
  satisfiesConstraintModel,
  visibleStatFromArmor,
  verifyWitness,
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
  const invalidVisible = createProblemSpec({
    target: { health: 201 },
    targetDomain: STAT_DOMAIN.VISIBLE,
  });
  assert.equal(invalidVisible.valid, false);
  assert.match(invalidVisible.errors.join("\n"), /target\.health.*0 and 200/);
});

test("visible 0/1/199/200 rules convert to Armor intervals for fragment +/-10/20", () => {
  const exact = Object.fromEntries(STATS.map(stat => [stat, true]));
  const tuningAssignments = STATS.slice(0, 5).map((stat, index) => ({
    mode: "+5-5",
    from: stat,
    to: STATS[(index + 1) % 5],
  }));

  for (const fragment of [-20, -10, 10, 20]) {
    for (const visible of [0, 1, 199, 200]) {
      const armor = visible - fragment;
      const target = Object.fromEntries(STATS.map(stat => [stat, visible]));
      const fragments = Object.fromEntries(STATS.map(stat => [stat, fragment]));
      const problemSpec = createProblemSpec({
        operation: "verify-test",
        target,
        fragments,
        constraints: { exact },
        targetDomain: STAT_DOMAIN.VISIBLE,
      });
      const witness = {
        // Deliberately false: verification must rebuild from the assignments.
        totals: Object.fromEntries(STATS.map(stat => [stat, 999])),
        config: Array.from({ length: 5 }, (_, index) => ({
          archetype: "Siegebreaker",
          tertiary: "melee",
          baseStats: Object.fromEntries(STATS.map(stat => [
            stat,
            index === 0 ? armor : 0,
          ])),
        })),
        tuningAssignments,
        modAssignments: Object.fromEntries(STATS.slice(0, 5).map((_, index) => [index, null])),
      };
      const verification = verifyWitness(problemSpec, witness);
      const solverInput = getArmorSolverInput(problemSpec);

      assert.equal(verification.valid, true, verification.errors.join("; "));
      assert.deepEqual(verification.armorTotals,
        Object.fromEntries(STATS.map(stat => [stat, armor])));
      assert.deepEqual(verification.visibleTotals, target);
      assert.equal(satisfiesConstraintModel(
        verification.witness,
        problemSpec.constraintModel,
        STAT_DOMAIN.VISIBLE,
      ), true);
      assert.equal(solverInput.target.health, armor);
      if (visible === 0) {
        assert.equal(solverInput.constraints.exact.health, false);
        assert.equal(solverInput.constraints.maximums.health, armor);
      } else if (visible === 200) {
        assert.equal(solverInput.constraints.exact.health, false);
        assert.equal(solverInput.constraints.minimums.health, armor);
      } else {
        assert.equal(solverInput.constraints.exact.health, true);
        assert.equal(solverInput.constraints.minimums.health, undefined);
        assert.equal(solverInput.constraints.maximums.health, undefined);
      }
    }
  }
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
  const config = Array.from({ length: 5 }, () => BASE_CONFIGS[0]);
  const tuningAssignments = config.map(() => ({
    mode: "+5-5",
    from: "health",
    to: "melee",
  }));
  const witness = {
    // The certificate must ignore these caller-provided totals.
    totals: { health: 0, melee: 0, grenade: 0, super: 0, class: 0, weapons: 0 },
    config,
    tuningAssignments,
    modAssignments: Object.fromEntries(config.map((_, index) => [index, null])),
  };
  const expectedArmorTotals = {
    health: 125,
    melee: 125,
    grenade: 125,
    super: 25,
    class: 25,
    weapons: 25,
  };
  const problemSpec = createProblemSpec({
    operation: "solve",
    target: expectedArmorTotals,
  });
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
  assert.deepEqual(cloned.certificate.witnessVerification.armorTotals, expectedArmorTotals);
  assert.equal(cloned.certificate.canonicalId, createCanonicalId({
    ...witness,
    totals: expectedArmorTotals,
    armorTotals: expectedArmorTotals,
    visibleTotals: expectedArmorTotals,
  }));
});

test("certificate builder rejects legacy Booleans and forged/replayed proof evidence", () => {
  const problemSpec = createProblemSpec({
    target: Object.fromEntries(STATS.map(stat => [stat, 1])),
    constraints: { exact: Object.fromEntries(STATS.map(stat => [stat, true])) },
  });
  const options = {
    producer: "exact-target-oracle",
    method: "exact-target-oracle",
    complete: true,
    statesExamined: 1,
    scope: "target-point",
    outcome: "infeasible",
    assumptions: ["known-data", "complete-catalog", "residue-rejection"],
  };
  const issued = createProofEvidence(problemSpec, options);
  const certify = (proof, spec = problemSpec) => createResultCertificate({
    status: RESULT_STATUS.INFEASIBLE_PROVEN, problemSpec: spec, proof,
  });
  assert.equal(certify(issued).status, RESULT_STATUS.INFEASIBLE_PROVEN);
  const cases = [
    { exhaustive: true },
    { ...issued },
    structuredClone(issued),
    createProofEvidence(problemSpec, { ...options, producer: "heuristic" }),
    createProofEvidence(problemSpec, { ...options, method: "bounded-fallback-search" }),
    createProofEvidence(problemSpec, { ...options, truncated: true }),
    createProofEvidence(problemSpec, { ...options, complete: false }),
    createProofEvidence(problemSpec, { ...options, assumptions: ["unknown-data"] }),
    createProofEvidence(problemSpec, { ...options, statesExamined: -1 }),
    createProofEvidence(problemSpec, { ...options, scope: "rule-domain" }),
    createProofEvidence(problemSpec, { ...options, outcome: "unknown" }),
    { ...issued, domain: STAT_DOMAIN.VISIBLE },
    null,
  ];
  for (const proof of cases) {
    assert.equal(certify(proof).status, RESULT_STATUS.SEARCH_LIMIT_REACHED,
      JSON.stringify(proof));
  }
  const differentProblem = createProblemSpec({ target: { health: 200 } });
  assert.notEqual(createRulesetId(differentProblem), issued.rulesetId);
  assert.equal(certify(issued, differentProblem).status, RESULT_STATUS.SEARCH_LIMIT_REACHED);
  assert.equal(certify(certify(issued).proof).status, RESULT_STATUS.SEARCH_LIMIT_REACHED,
    "a serialized audit certificate cannot mint a new certificate");
});

test("a complete point oracle does not prove interval or fuzzy-rule infeasibility", () => {
  for (const targetDomain of [STAT_DOMAIN.ARMOR, STAT_DOMAIN.VISIBLE]) {
    const problemSpec = createProblemSpec({
      target: { health: 200 }, targetDomain,
      constraints: { exact: { health: true } },
    });
    const proof = createProofEvidence(problemSpec, {
      producer: "exact-target-oracle", method: "exact-target-oracle",
      complete: true, scope: "target-point", outcome: "infeasible",
      assumptions: ["known-data"], statesExamined: 1,
    });
    assert.equal(createResultCertificate({
      status: RESULT_STATUS.INFEASIBLE_PROVEN, problemSpec, proof,
    }).status, RESULT_STATUS.SEARCH_LIMIT_REACHED);
  }
});

test("point-rule reachability evidence cannot authorize a clamped interval proof", () => {
  const problemSpec = createProblemSpec({
    operation: "calculateReachability", target: { health: 200 },
    targetDomain: STAT_DOMAIN.VISIBLE, constraints: { exact: { health: true } },
  });
  const proof = createProofEvidence(problemSpec, {
    producer: "reachability-dp", method: "point-rule-dynamic-programming",
    complete: true, assumptions: ["known-data"], outcome: "infeasible",
  });
  const result = createResultCertificate({
    status: RESULT_STATUS.INFEASIBLE_PROVEN, problemSpec, proof,
  });
  assert.equal(result.status, RESULT_STATUS.SEARCH_LIMIT_REACHED);
  assert.equal(result.proof.complete, false);
  assert.match(result.proof.validationErrors.join(";"), /interval-complete/);
});

test("caller-supplied verification cannot bypass witness reconstruction", () => {
  const problemSpec = createProblemSpec();
  const fakeWitness = { totals: Object.fromEntries(STATS.map(stat => [stat, 0])) };
  for (const status of [RESULT_STATUS.EXACT_TARGET_PROVEN, RESULT_STATUS.RULE_FEASIBLE_PROVEN]) {
    const result = createResultCertificate({
      status, problemSpec, witness: fakeWitness,
      verification: { valid: true, witness: fakeWitness, errors: [] },
    });
    assert.equal(result.status, RESULT_STATUS.SEARCH_LIMIT_REACHED);
    assert.equal(result.witnessVerification.valid, false);
    assert.equal(createResultCertificate({ status, problemSpec }).status,
      RESULT_STATUS.SEARCH_LIMIT_REACHED, "no witness is not a feasibility proof");
  }
});
