import assert from "node:assert/strict";
import test from "node:test";
import { BASE_CONFIGS, STATS } from "../src/core/armor-model.mjs";
import { createProblemSpec, verifyWitness } from "../src/core/solver-v3-contract.mjs";
import { normalizeUpgradePiece } from "../src/core/upgrade-optimizer.mjs";
import { assignArmorMods } from "../src/core/armor-mod-assignment.mjs";
import { rankInventoryPlans } from "../src/core/inventory-plan.mjs";
import { analyzeUpgrade, solveInventory, calculateReachability } from "../src/core/armor-engine.mjs";
import { createDefaultUpgradePiece, getManualUpgradeArmorTotals, getUpgradeConfig, analyzeUpgradeCandidates, evaluateUpgradePieces, applyUpgradeEvaluationToPieces } from "../src/core/upgrade-optimizer.mjs";
import { rebuildReference, seeded } from "./helpers/reference-witness.mjs";

const slots = ["helmet", "arms", "chest", "legs", "classItem"];
export function fixture(destination = "grenade") {
  const pieces = slots.map((slot, index) => ({
    ...BASE_CONFIGS[index], slot, sourceId: `A-${index}`, hash: 100 + index,
    archetypeId: BASE_CONFIGS[index].archetype, tunedStat: destination,
    allowedTuningStats: [destination], exotic: false,
    tuningMode: "shift", tuningTo: destination,
    tuningFrom: STATS.find(stat => stat !== destination), armorModSize: 0,
  }));
  const witness = {
    pieces, tuningAssignments: pieces.map(p => ({mode: "+5-5", from: p.tuningFrom, to: destination})),
    modAssignments: Object.fromEntries(pieces.map((_, index) => [index, null])),
  };
  const problem = createProblemSpec({operation: "analyzeUpgrade", pieces});
  return { pieces, witness, problem };
}

for (const stat of STATS) {
  test(`immutable Legendary destination: ${stat}`, () => {
    const { witness, problem } = fixture(stat);
    assert.equal(verifyWitness(problem, witness).valid, true);
    const corrupt = structuredClone(witness);
    corrupt.tuningAssignments[0].to = STATS.find(s => s !== stat && s !== corrupt.tuningAssignments[0].from);
    assert.equal(verifyWitness(problem, corrupt).valid, false);
  });
}

test("verifier rejects changed source identity, base, Exotic and missing armor", () => {
  const { witness, problem } = fixture();
  for (const mutate of [
    w => { w.pieces[0].sourceId = "different-instance"; },
    w => { w.pieces[0].baseStats.health++; },
    w => { w.pieces[0].tunedStat = "melee"; },
    w => { w.pieces[0].exotic = true; w.pieces[1].exotic = true; },
    w => { w.pieces.pop(); },
  ]) {
    const corrupt = structuredClone(witness);
    mutate(corrupt);
    assert.equal(verifyWitness(problem, corrupt).valid, false);
  }
});

test("an old owned draft with no tuning evidence must not acquire a rolled direction", () => {
  const piece = normalizeUpgradePiece({sourceId: "old-save", tuningMode: "shift"}, 0);
  assert.equal(piece.tunedStat, null);
  assert.equal(piece.tuningTo, null);
  assert.equal(piece.tuningFrom, null);
});

test("empty execution input is blocked, never VERIFIED", () => {
  assert.equal(assignArmorMods({}).executionStatus, "BLOCKED");
});

test("mixed owned/farm matching does not reuse theoretical totals for a different physical base", () => {
  const { witness, problem } = fixture();
  const solution = {...witness, config: witness.pieces, exoticIndex: null, score: 0,
    totals: verifyWitness(problem, witness).armorTotals};
  const items = witness.pieces.map((p, index) => ({...p, id: p.sourceId,
    baseStats: {...p.baseStats, health: p.baseStats.health + index + 1},
    masterworkTier: 5, effectiveBaseStats: {...p.baseStats, health: p.baseStats.health + index + 1},
    optimizationBaseStats: {...p.baseStats, health: p.baseStats.health + index + 1},
  }));
  const [plan] = rankInventoryPlans({solutions: [solution], items});
  assert.equal(plan.ownedCount, 0, "every matching item has a different physical base");
});

test("Upgrade step snapshots have final assignment and final canonical identity", () => {
  const pieces = slots.map((_, index) => createDefaultUpgradePiece(index));
  const result = analyzeUpgrade({pieces, targets: {health:40, melee:80, grenade:100, super:100, class:60, weapons:120},
    fragments:{}, reassignModifiers:true, constraints:{exact:Object.fromEntries(STATS.map(s => [s,true]))}});
  assert.equal(result.verified, true, JSON.stringify(result.plan?.consistencyErrors));
  assert.ok(result.plan.steps.length > 0);
  for (const step of result.plan.steps) {
    const w = step.verifiedWitness;
    assert.ok(w);
    assert.deepEqual(w.pieces.map(p=>p.sourceId), step.pieces.map(p=>p.sourceId));
    assert.deepEqual(w.pieces.map(p=>p.tunedStat), step.pieces.map(p=>p.tunedStat));
    assert.deepEqual(rebuildReference(w.pieces, w.tuningAssignments, w.modAssignments, w.fragments).visible, step.evaluation.finalTotals);
  }
  assert.equal(result.plan.steps.at(-1).verifiedWitness.canonicalId, result.plan.canonicalId);
});

test("256 seeded retained-instance assignments never drift in any of the six directions", () => {
  const random = seeded(0x51a7e);
  for (let trial=0; trial<256; trial++) {
    const destination = STATS[random(6)];
    const {pieces, problem, witness} = fixture(destination);
    witness.tuningAssignments = pieces.map(() => random(2) ? {mode:'+3',from:null,to:null}
      : {mode:'+5-5',from:STATS[(STATS.indexOf(destination)+1+random(5))%6],to:destination});
    const actual = verifyWitness(problem, witness);
    assert.equal(actual.valid, true, actual.errors.join(';'));
    assert.deepEqual(rebuildReference(pieces,witness.tuningAssignments,witness.modAssignments).armor,actual.armorTotals);
  }
});

test("Reachability cache cannot retain a previous probe or a mutated range", () => {
  const payload = {fixedPiece:BASE_CONFIGS[0],numPlus5:0,numPlus10:0,numPlus3:5,fragments:{},lockedTargets:{}};
  const a = calculateReachability({...payload,probeTarget:{health:0,melee:0,grenade:0,super:0,class:0,weapons:0}});
  a.ranges.health.values.push(123456);
  const b = calculateReachability(payload);
  assert.equal(b.probe, undefined);
  assert.equal(b.ranges.health.values.includes(123456), false);
});

test("bounded inventory resource exhaustion cannot prove infeasibility", () => {
  const pieces = slots.map((_,i)=>createDefaultUpgradePiece(i));
  const items = pieces.flatMap((p,index)=>Array.from({length:8},(_,n)=>({
    ...p,id:`${index}-${n}`,sourceId:undefined,...getUpgradeConfig(p),archetypeId:p.archetypeId,
    effectiveBaseStats:{...getUpgradeConfig(p).baseStats,health:n+5},
    optimizationBaseStats:{...getUpgradeConfig(p).baseStats,health:n+5},
  })));
  const result=solveInventory({items,targets:{...getManualUpgradeArmorTotals(pieces),health:199},fragments:{},
    userConstraints:{exact:Object.fromEntries(STATS.map(s=>[s,true]))},setRequirement:{type:'none'},reassignModifiers:false,
    searchLimits:{maxStates:2,maxEvaluations:2}});
  assert.equal(result.searchStats.frontierComplete,false);
  assert.notEqual(result.status,'INFEASIBLE_PROVEN');
});

test("Upgrade cache does not replay retained instances from an identical-stat prior request", () => {
  const pieces=slots.map((_,i)=>({...createDefaultUpgradePiece(i),sourceId:`first-${i}`,locked:i<4,
    baseStats:{...getUpgradeConfig(createDefaultUpgradePiece(i)).baseStats}}));
  const replacement={...pieces[4],sourceId:null,archetypeId:BASE_CONFIGS[0].archetype,tertiary:BASE_CONFIGS[0].tertiary,baseStats:{...BASE_CONFIGS[0].baseStats}};
  const target=getManualUpgradeArmorTotals([...pieces.slice(0,4),replacement]);
  const a=analyzeUpgradeCandidates(pieces,target,{},false);
  assert.ok(a.plan);
  const later=pieces.map((p,i)=>({...p,sourceId:`second-${i}`}));
  const b=analyzeUpgradeCandidates(later,target,{},false);
  assert.ok(b.plan);
  assert.deepEqual(b.plan.pieces.slice(0,4).map(p=>p.sourceId),later.slice(0,4).map(p=>p.sourceId));
});

test("64 seeded Upgrade reassign/manual/onlyPlus5/Exotic/unknown cases preserve physical state", () => {
  const random=seeded(0xa1160);
  for(let trial=0;trial<64;trial++) {
    const pieces=slots.map((_,index)=>{
      const config=BASE_CONFIGS[random(48)];
      const destination=STATS[random(6)];
      return normalizeUpgradePiece({sourceId:`fuzz-${index}`,archetypeId:config.archetype,tertiary:config.tertiary,
        baseStats:{...config.baseStats},tunedStat:destination,allowedTuningStats:index===0&&trial%4===0?STATS:[destination],
        exotic:index===0&&trial%4===0,tuningMode:trial%3===0?'plus3':'shift',tuningTo:destination,
        tuningFrom:STATS[(STATS.indexOf(destination)+1)%6],armorModSize:[0,5,10][random(3)],armorModStat:STATS[random(6)]},index);
    });
    const target=Object.fromEntries(STATS.map(s=>[s,random(150)]));
    const reassign=trial%2===0, only=trial%5===0;
    const evaluation=evaluateUpgradePieces(pieces,target,{},reassign,[],only);
    const after=applyUpgradeEvaluationToPieces(pieces,evaluation);
    for(let i=0;i<5;i++) {
      assert.equal(after[i].sourceId,pieces[i].sourceId);
      assert.equal(after[i].tunedStat,pieces[i].tunedStat);
      assert.deepEqual(after[i].baseStats,pieces[i].baseStats);
    }
    assert.deepEqual(rebuildReference(after,evaluation.tuningAssignments,evaluation.modAssignments).visible,evaluation.finalTotals);
    if(trial%8===0) {
      const unknown={...pieces[1],tunedStat:null,allowedTuningStats:null,tuningUnknown:true,tuningFrom:null,tuningTo:null};
      const uncertain=evaluateUpgradePieces([pieces[0],unknown,...pieces.slice(2)],target,{},false);
      assert.equal(uncertain.tuningAssignments[1],null);
    }
  }
});
