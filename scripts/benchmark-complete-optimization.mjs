// Deterministic synthetic comparison. Pass a source checkout as the first
// argument to run the same cases against a baseline, without editing it.
// Timings are Node CPU observations, not browser INP or real-account latency.
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const load = file => import(pathToFileURL(path.join(root, 'src/core', file)));
const {BASE_CONFIGS, STATS} = await load('armor-model.mjs');
const {findExactTargetWitnesses} = await load('exact-target-oracle.mjs');
const {normalizeUpgradePiece} = await load('upgrade-optimizer.mjs');
const {analyzeUpgrade, calculateReachability} = await load('armor-engine.mjs');
const {evaluateConfig} = await load('solver.mjs');
const exact = {exact: Object.fromEntries(STATS.map(s => [s, true]))};
const vector = values => Object.fromEntries(STATS.map((s, i) => [s, values[i]]));
const rows = [];
const timed = (name, execute, summarize) => {
  const started = performance.now();
  const result = execute();
  const elapsedMs = performance.now() - started;
  rows.push({name, elapsedMs, ...summarize(result)});
};

const base = BASE_CONFIGS[0];
const optionalTarget = Object.fromEntries(STATS.map(s =>
  [s, base.baseStats[s] * 5 + (base.masterworkStats.includes(s) ? 4 : 0)]));
timed('scratch-four-balanced-one-empty', () => findExactTargetWitnesses({
  target: optionalTarget, numPlus5: 0, numPlus10: 0, numPlus3: 4,
}), results => ({witnesses: results.length, target: optionalTarget,
  emptySlots: results[0]?.tuningAssignments.filter(t => t.mode === 'none').length ?? null}));

const config = BASE_CONFIGS.find(c => c.archetype === 'Gunner' && c.tertiary === 'super');
const pieces = Array.from({length: 5}, (_, i) => normalizeUpgradePiece({
  archetypeId: config.archetype, tertiary: config.tertiary, baseStats: {...config.baseStats},
  sourceId: String(i + 1), tuningMode: 'shift', tunedStat: 'melee', allowedTuningStats: ['melee'],
  tuningTo: 'melee', tuningFrom: 'health', tuningInstalled: true, armorModSize: 0, locked: true,
  dataConfidence: {stats: 'exact', tuning: 'exact', sockets: 'unknown'},
}, i));
timed('upgrade-remove-one-tuning', () => analyzeUpgrade({pieces,
  targets: vector([5, 45, 125, 100, 25, 150]), fragments: {}, reassignModifiers: true,
  onlyPlus5Tuning: false, constraints: exact,
}), result => ({status: result.status, totals: result.baseline.finalTotals,
  reachedCount: result.baseline.metrics.reachedCount,
  emptySlots: result.baseline.tuningAssignments.filter(t => t.mode === 'none').length,
  assignmentOptimal: result.baseline.assignmentOptimal === true}));

const target = vector([120, 95, 80, 25, 95, 45]);
timed('fixed-five-rule-count', () => evaluateConfig([0, 5, 10, 15, 20].map(i => BASE_CONFIGS[i]),
  target, 0, 0, 0, exact, null, {skipExactJointSearch: true}), result => ({totals: result.totals,
  reachedCount: STATS.filter(s => result.totals[s] === target[s]).length}));

const fixedPiece = {...BASE_CONFIGS.find(c => c.archetype === 'Brawler' && c.tertiary === 'grenade'), exotic: true};
const locks = vector([100, 50, 100, 100, 0, 0]);
for (const count of [2, 3, 4]) {
  const payload = {fixedPiece, numPlus5: 0, numPlus10: 5, numPlus3: 0, fragments: {},
    lockedTargets: Object.fromEntries(STATS.slice(0, count).map(s => [s, locks[s]]))};
  for (const temperature of ['miss', 'hit']) timed(`reachability-${count}-locks-${temperature}`,
    () => calculateReachability(payload), result => ({status: result.status,
      feasible: result.feasible, states: result.searchStats?.statesExamined ?? null}));
}
console.log(JSON.stringify({root, node: process.version, timingScope: 'single-process synthetic CPU; not browser latency', rows}, null, 2));
