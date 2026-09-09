import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

// Separate processes preserve cold-cache comparisons and contain adversarial
// inputs. This script only reads fixtures; it never connects to Bungie.
const self = fileURLToPath(import.meta.url);
const root = path.resolve(process.argv[2] || '.');
if (process.argv[3] === 'scratch') {
  const {BASE_CONFIGS, STATS} = await import(pathToFileURL(path.join(root, 'src/core/armor-model.mjs')));
  const {findExactTargetWitnesses, getOracleDiagnostics} = await import(pathToFileURL(path.join(root, 'src/core/exact-target-oracle.mjs')));
  const mode = Number(process.argv[4]);
  const target = Object.fromEntries(STATS.map(stat => [stat, 0]));
  BASE_CONFIGS.slice(0, 5).forEach((config, i) => {
    for (const stat of STATS) target[stat] += config.baseStats[stat];
    if (i < mode) for (const stat of config.masterworkStats) target[stat]++;
    else { target.health -= 5; target.melee += 5; }
  });
  const searchStats = {};
  const started = performance.now();
  const result = findExactTargetWitnesses({target, numPlus3: mode, numPlus5: 0, numPlus10: 0, searchStats});
  console.log(JSON.stringify({case: `scratch-${mode}`, searchMs: performance.now() - started,
    statesExamined: searchStats.statesExamined, witnesses: result.length, diagnostics: getOracleDiagnostics?.(), rss: process.memoryUsage().rss}));
} else {
  const baseline = path.resolve(process.argv[3] || '../d2-armor-solver');
  const rows = [];
  for (let trial = 0; trial < 3; trial++) for (const [version, directory] of [['baseline', baseline], ['optimized', root]]) {
    for (const name of ['hard-rules', 'late-exact', 'equivalent', 'scratch-2', 'scratch-3']) {
      const args = name.startsWith('scratch') ? [self, directory, 'scratch', name.at(-1)]
        : [path.join(root, 'scripts/benchmark-v3-realistic.mjs'), directory, name, 'balanced'];
      const child = spawnSync(process.execPath, args, {encoding: 'utf8', windowsHide: true, timeout: 45000});
      if (child.status !== 0) throw new Error(`${version}/${name}: ${child.error?.message || child.stderr}`);
      const row = {version, trial, case: name, ...JSON.parse(child.stdout)};
      rows.push(row); console.log(JSON.stringify(row));
    }
  }
  writeFileSync(path.join(root, 'docs/benchmarks/solver-v31.json'), JSON.stringify({node: process.version, rows}, null, 2) + '\n');
}
