import assert from "node:assert/strict";
import test from "node:test";
import { BASE_CONFIGS, STATS } from "../src/core/armor-model.mjs";
import { solveLoadout, solveInventory } from "../src/core/armor-engine.mjs";
import { solveLoadoutAsync } from "../src/core/armor-engine-client.mjs";
import { createProblemSpec, verifyWitness, createSolutionDisplayModel, sealWitness, assertSolutionConsistency } from "../src/core/solver-v3-contract.mjs";
import { exhaustiveInventory, rebuildReference, seeded, SLOTS, ZERO, compareReference } from "./helpers/reference-witness.mjs";
import { findBestFixedConfigWitness } from "../src/core/exact-target-oracle.mjs";
const EXACT = Object.fromEntries(STATS.map(s => [s, true]));
const SEED = 0xc0ffee;

test("120 seeded generated-reachable Scratch witnesses survive independent rebuild + display serialization", async () => {
  const random = seeded(SEED);
  for (let trial = 0; trial < 120; trial++) {
    const config = Array.from({length: 5}, () => BASE_CONFIGS[random(48)]);
    const plus3 = trial % 6;
    const tuning = config.map((_, i) => {
      const from = random(6);
      return i < plus3 ? {mode: "+3", from: null, to: null} : {mode: "+5-5", from: STATS[from], to: STATS[(from + 1 + random(5)) % 6]};
    });
    const mods = config.map((_, i) => i < 2 ? {stat: STATS[random(6)], size: 5} : {stat: STATS[random(6)], size: 10});
    const target = rebuildReference(config, tuning, mods).armor;
    const payload = {target, constraints: {exact: EXACT}, numPlus5: 2, numPlus10: 3, numPlus3: plus3, runtimeOptions: {maxExactSolutions: 1}};
    const result = solveLoadout(payload);
    assert.equal(result.status, "EXACT_TARGET_PROVEN", `seed=${SEED} trial=${trial}`);
    const model = JSON.parse(JSON.stringify(createSolutionDisplayModel(result[0])));
    const independent = rebuildReference(model.pieces, model.tuningAssignments, model.modAssignments, model.fragments);
    assert.deepEqual(independent.armor, target);
    assert.deepEqual(independent.visible, model.visibleTotals);
    assertSolutionConsistency(model.problemSpec, model, model.visibleTotals);
    if (trial % 6 === 0) {
      // Adapter equivalence compares the completed exact domain. Balanced is
      // now time-bounded and may retain a different equally valid incumbent.
      const again = await solveLoadoutAsync({...payload, searchProfile: "deep"});
      assert.equal(again.search.termination, "completed");
      assert.equal(again[0].canonicalId, result[0].canonicalId);
    }
  }
});

test("eight seeded small inventories (2..6 per slot) agree with exhaustive enumeration", () => {
  const random = seeded(SEED + 1);
  for (let trial = 0; trial < 8; trial++) {
    const count = 2 + trial % 5;
    const items = SLOTS.flatMap((slot, index) => Array.from({length: count}, (_, n) => {
      const config = BASE_CONFIGS[random(48)];
      const destination = STATS[random(6)];
      return {...config, id: `${index}-${n}`, slot, hash: 100 + index,
        archetypeId: config.archetype, effectiveBaseStats: {...config.baseStats}, optimizationBaseStats: {...config.baseStats},
        tunedStat: destination, allowedTuningStats: [destination], tuningMode: "shift", tuningTo: destination,
        tuningFrom: STATS[(STATS.indexOf(destination) + 1) % 6], armorModSize: [0, 5, 10][n % 3], armorModStat: STATS[index],
        exotic: index < 2 && n === 1, setHash: n % 2 ? 701 : 700, masterworkTier: 5,
        dataConfidence: {stats: "exact", tuning: "exact", sockets: "unknown"}};
    }));
    const selected = SLOTS.map(slot => items.find(p => p.slot === slot));
    const target = rebuildReference(selected, selected.map(p => ({mode: "+5-5", from: p.tuningFrom, to: p.tuningTo})), {}).visible;
    if (trial % 2) target.melee++;
    const setRequirement = trial % 3 ? {type: "none"} : {type: "set", setHash: 700, count: 4};
    const constraints = {exact: EXACT, priorityLevels: trial % 2 ? {grenade: 1, melee: 2} : {}};
    const reference = exhaustiveInventory({items, target, constraints, setRequirement});
    const payload = {items, targets: target, fragments: ZERO, userConstraints: constraints,
      reassignModifiers: false, setRequirement, maxResults: 1};
    const production = solveInventory(payload);
    assert.notEqual(production.status, reference.exact ? "INFEASIBLE_PROVEN" : "EXACT_TARGET_PROVEN");
    assert.deepEqual(production.results[0].finalTotals, reference.best.totals, `seed=${SEED+1} trial=${trial}`);
    const reversed = solveInventory({...payload, items: [...items].reverse()});
    assert.equal(production.results[0].canonicalId, reversed.results[0].canonicalId);
    const best = production.results[0];
    assert.deepEqual(rebuildReference(best.pieces, best.tuningAssignments, best.modAssignments).visible, best.finalTotals);
  }
});

test("sealed witness corruption rejects mods, fragments, identities, base and missing armor", () => {
  const pieces = BASE_CONFIGS.slice(0, 5);
  const spec = createProblemSpec({operation: "solve", numPlus3: 5, numPlus10: 1});
  const sealed = sealWitness(spec, {config: pieces, tuningAssignments: pieces.map(() => ({mode: "+3", from: null, to: null})),
    modAssignments: {0: {size: 10, stat: "health"}, 1: null, 2: null, 3: null, 4: null}}).witness;
  assert.ok(sealed);
  for (const mutate of [
    w => { w.modAssignments[0].stat = "melee"; },
    w => { w.modAssignments[0].size = 5; },
    w => { w.config[0].baseStats.health++; },
    w => { w.config[0].sourceId = "forged"; },
    w => { w.config.pop(); },
    w => { w.fragments.health = 10; },
    w => { w.visibleTotals.health++; },
    w => { w.config[0].masterworkStats = ["health", "melee", "grenade"]; },
  ]) {
    const corrupt = structuredClone(sealed); mutate(corrupt);
    // masterworkStats is presentation metadata; the verifier derives it from
    // the immutable framework and must reject a contradictory displayed list.
    assert.equal(verifyWitness(spec, corrupt).valid, false);
  }
});

test("visible boundary matrix uses exact integer clamp, including negative fragments", () => {
  for (const fragment of [-20, -10, 0, 10, 20]) for (const target of [0, 1, 199, 200]) {
    const problem = createProblemSpec({operation: "verify-test", targetDomain: "visible",
      target: Object.fromEntries(STATS.map(s => [s, target])), fragments: Object.fromEntries(STATS.map(s => [s, fragment])), constraints: {exact: EXACT}});
    const pieces = BASE_CONFIGS.slice(0, 5).map((p, index) => ({...p,
      baseStats: Object.fromEntries(STATS.map(s => [s, index === 0 ? target - fragment : 0]))}));
    const tuning = pieces.map((_, i) => ({mode: "+5-5", from: STATS[i], to: STATS[(i+1)%5]}));
    const checked = verifyWitness(problem, {config: pieces, tuningAssignments: tuning, modAssignments: {}});
    assert.equal(checked.valid, true);
    assert.deepEqual(checked.visibleTotals, problem.constraintModel.target);
  }
});

test("16 exhaustive tiny Tuning/mod domains agree with V3 restricted residual search", () => {
  const random = seeded(0x0fac1e);
  for (let trial=0;trial<16;trial++) {
    const items=SLOTS.map((slot,index)=>{
      const config=BASE_CONFIGS[random(48)];
      return {...config,id:`ref-${index}`,slot,archetypeId:config.archetype,allowedTuningStats:index<2?[STATS[random(6)]]:[],
        tuningMode:'plus3',armorModSize:index===0?5:0,armorModStat:'health',setHash:null};
    });
    const tuning=items.map((p,index)=>index===0?{mode:'+5-5',to:p.allowedTuningStats[0],from:STATS[(STATS.indexOf(p.allowedTuningStats[0])+1)%6]}:{mode:'+3',from:null,to:null});
    const target=rebuildReference(items,tuning,{0:{size:5,stat:STATS[random(6)]}}).visible;
    if(trial%2) target.health++;
    const reference=exhaustiveInventory({items,target,constraints:{exact:EXACT},reassign:true});
    const actual=findBestFixedConfigWitness({configs:items,target,numPlus5:1,numPlus10:0,numPlus3:0,
      tuningCapabilities:items.map(p=>({allowBalanced:true,allowedDirectionalStats:p.allowedTuningStats})),
      rankTotals:totals=>[STATS.reduce((sum,s)=>sum+Math.abs(totals[s]-target[s]),0)],compareRanks:compareReference});
    assert.equal(actual.rank[0]===0,reference.exact,`seed=0x0fac1e trial=${trial}`);
    assert.deepEqual(rebuildReference(items,actual.tuningAssignments,actual.modAssignments).armor,actual.totals);
  }
});
