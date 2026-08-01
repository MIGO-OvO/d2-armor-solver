// Runnable check for the upgrade optimizer: every number the plan prints must be
// reproducible by following the configuration the plan prints.
// Usage: node check-upgrade-plan.js
const assert = require('assert');

(async () => {
const S = {
  ...(await import('./src/core/armor-model.mjs')),
  ...(await import('./src/core/upgrade-optimizer.mjs')),
};
const STATS = S.STATS;
const fmt = o => STATS.map(s => `${s}=${o[s]}`).join(' ');
const totalsOf = (pieces, fragments) =>
  S.finalizeUpgradeTotals(S.getManualUpgradeArmorTotals(pieces), fragments);

// Deterministic pseudo-random loadouts so the check is reproducible.
function makeRandom(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

function randomLoadout(rand) {
  return S.UPGRADE_SLOTS.map((_, index) => {
    const archetype = S.ARCHETYPES[Math.floor(rand() * S.ARCHETYPES.length)];
    const tertiaries = STATS.filter(s => s !== archetype.primary && s !== archetype.secondary);
    return S.normalizeUpgradePiece({
      archetypeId: archetype.id,
      tertiary: tertiaries[Math.floor(rand() * tertiaries.length)],
      tuningMode: rand() < 0.3 ? 'plus3' : 'shift',
      tuningFrom: STATS[Math.floor(rand() * STATS.length)],
      tuningTo: STATS[Math.floor(rand() * STATS.length)],
      armorModSize: [0, 5, 10][Math.floor(rand() * 3)],
      armorModStat: STATS[Math.floor(rand() * STATS.length)],
      locked: rand() < 0.2,
    }, index);
  });
}

let plansChecked = 0;
for (const reassignModifiers of [false, true]) {
  const rand = makeRandom(4242);
  for (let trial = 0; trial < 40; trial++) {
    const pieces = randomLoadout(rand);
    const targets = Object.fromEntries(STATS.map(s => [s, Math.round(rand() * 20) * 5]));
    const fragments = Object.fromEntries(STATS.map(s => [s, Math.round((rand() - 0.4) * 24)]));
    const analysis = S.analyzeUpgradeCandidates(pieces, targets, fragments, reassignModifiers);
    const label = `reassign=${reassignModifiers} trial=${trial}`;

    // The "keep your armor" branch must be reproducible from its own assignments.
    const baseConfigured = S.applyUpgradeEvaluationToPieces(pieces, analysis.baseline);
    assert.deepStrictEqual(
      totalsOf(baseConfigured, fragments), analysis.baseline.finalTotals,
      `${label}: baseline totals unreachable\n  shown   ${fmt(analysis.baseline.finalTotals)}\n  rebuilt ${fmt(totalsOf(baseConfigured, fragments))}`
    );

    const plan = analysis.plan;
    if (!plan) continue;
    plansChecked++;

    // Headline totals must come out of the recommended pieces plus the printed
    // tuning and mod layout — nothing else.
    const configured = S.applyUpgradeEvaluationToPieces(plan.pieces, plan.evaluation);
    assert.deepStrictEqual(
      totalsOf(configured, fragments), plan.evaluation.finalTotals,
      `${label}: plan totals unreachable\n  shown   ${fmt(plan.evaluation.finalTotals)}\n  rebuilt ${fmt(totalsOf(configured, fragments))}`
    );

    // Reassigning mods must never repoint a tuning mod's +5 side: that stat is
    // rolled onto the piece you already own, only the -5 source is free.
    const rearranged = S.evaluateUpgradePieces(pieces, targets, fragments, true);
    pieces.forEach((piece, index) => {
      const tuning = rearranged.tuningAssignments[index];
      if (piece.tuningMode === 'plus3') {
        assert.strictEqual(tuning.mode, '+3', `${label}: slot ${index} changed a +3 piece into +5/-5`);
        return;
      }
      assert.strictEqual(tuning.mode, '+5-5', `${label}: slot ${index} changed a +5/-5 piece into +3`);
      assert.strictEqual(
        tuning.to, piece.tuningTo,
        `${label}: slot ${index} moved the rolled +5 from ${piece.tuningTo} to ${tuning.to}`
      );
    });

    // Each step row's stats must be what the player sees after that swap, with
    // the same tuning/mod the row prints. Slots not yet swapped still hold the
    // owned piece: its archetype, tertiary, tuning mode, and rolled +5 stat.
    let walk = configured.map((piece, index) => S.normalizeUpgradePiece({
      ...piece,
      archetypeId: pieces[index].archetypeId,
      tertiary: pieces[index].tertiary,
      tuningMode: pieces[index].tuningMode,
      tuningTo: pieces[index].tuningTo,
    }, index));
    plan.steps.forEach((step, stepIndex) => {
      walk = walk.map((piece, index) => index === step.slotIndex ? { ...configured[index] } : piece);
      assert.deepStrictEqual(
        totalsOf(walk, fragments), step.evaluation.finalTotals,
        `${label}: step ${stepIndex + 1} totals unreachable\n  shown   ${fmt(step.evaluation.finalTotals)}\n  rebuilt ${fmt(totalsOf(walk, fragments))}`
      );
      assert.deepStrictEqual(
        step.evaluation.tuningAssignments[step.slotIndex],
        plan.evaluation.tuningAssignments[step.slotIndex],
        `${label}: step ${stepIndex + 1} prints a tuning it did not use`
      );
    });

    // The last step has to land exactly on the advertised result.
    const last = plan.steps[plan.steps.length - 1];
    if (last) {
      assert.deepStrictEqual(
        last.evaluation.finalTotals, plan.evaluation.finalTotals,
        `${label}: final step disagrees with the headline totals`
      );
    }

    // Locked pieces must never be swapped out, and a swap must always change
    // something the player has to farm.
    pieces.forEach((piece, index) => {
      if (!piece.locked) return;
      assert.ok(
        S.sameUpgradeIdentity(
          S.getUpgradePieceIdentity(piece), S.getUpgradePieceIdentity(plan.pieces[index])
        ),
        `${label}: locked slot ${index} replaced`
      );
    });
    plan.steps.forEach((step, stepIndex) => {
      assert.ok(
        !S.sameUpgradeIdentity(
          S.getUpgradePieceIdentity(step.beforePiece), S.getUpgradePieceIdentity(step.afterPiece)
        ),
        `${label}: step ${stepIndex + 1} asks for a swap that changes nothing`
      );
    });
  }
}
// A loadout that only lacks a differently-rolled +5 must be reported as "farm a
// piece", never as "keep your armor" — the +5 side cannot be re-picked on gear
// you already own.
(function plus5OnlyScenario() {
  const pieces = S.UPGRADE_SLOTS.map((_, index) => S.normalizeUpgradePiece({
    archetypeId: ['Brawler', 'Grenadier', 'Paragon', 'Specialist', 'Gunner'][index],
    tuningMode: 'shift', tuningFrom: 'health', tuningTo: 'weapons',
    armorModSize: 10, armorModStat: 'class',
  }, index));
  const fragments = Object.fromEntries(STATS.map(s => [s, 0]));
  const entered = totalsOf(pieces, fragments);
  // Move 5 points from weapons to class: no mod rearrangement can do this,
  // because every piece rolled its +5 on weapons.
  const targets = { ...entered, class: entered.class + 5, weapons: entered.weapons - 5 };
  const analysis = S.analyzeUpgradeCandidates(pieces, targets, fragments, true);

  assert.ok(
    !analysis.baseline.metrics.allReached,
    'plus5-only scenario: claimed the current armor already meets the targets'
  );
  assert.ok(analysis.plan, 'plus5-only scenario: no plan produced');
  assert.strictEqual(
    analysis.plan.replacementCount, 1,
    `plus5-only scenario: expected a single swap, got ${analysis.plan.replacementCount}`
  );
  const [step] = analysis.plan.steps;
  assert.ok(step.tuningOnly, 'plus5-only scenario: the swap should differ only in the rolled +5');
  assert.strictEqual(
    step.afterPiece.tuningTo, 'class',
    `plus5-only scenario: expected a +5 class roll, got +5 ${step.afterPiece.tuningTo}`
  );
  assert.ok(
    analysis.plan.metrics.allReached,
    'plus5-only scenario: the single swap should reach every target'
  );
  console.log('plus5-only scenario OK (1 swap, rolled +5 only)');
})();

console.log(`upgrade plan check OK (${plansChecked} plans verified)`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
