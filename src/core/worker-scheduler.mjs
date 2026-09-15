// Resource policy, not solver math. All estimates may be wrong without
// changing shard membership, legal candidates or certificate semantics.
export const EMERGENCY_WORKER_CAP = 256; // Reject corrupt/unbounded runtime hints.
const slots = ['helmet', 'arms', 'chest', 'legs', 'classItem'];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function inventoryWorkEstimate(payload) {
  const rows = slots.map(slot => {
    const locked = payload.currentPieces?.find(p => p.slot === slot && p.locked);
    const items = locked ? [locked] : (payload.items || []).filter(p => p.slot === slot && (!payload.fixedExotic
      || (slot === payload.fixedExotic.slot ? p.exotic : !p.exotic)));
    // Cheap scheduling signature only; NEVER used for solver compression.
    const groups = new Set(items.map(p => JSON.stringify([p.optimizationBaseStats || p.effectiveBaseStats || p.baseStats,
      p.archetypeId, p.tertiary, p.tunedStat, p.allowedTuningStats, p.exotic, p.setHash, p.classId,
      p.tuningMode, p.armorModSize]))).size;
    return {physical: items.length, groups};
  }).sort((a, b) => a.physical - b.physical);
  return {items: payload.items?.length || 0, rows,
    shardableDomain: rows[0].physical,
    physicalCombinations: rows.reduce((n, r) => Math.min(1e15, n * r.physical), 1),
    mathCombinations: rows.reduce((n, r) => Math.min(1e15, n * r.groups), 1)};
}

export function chooseInventorySchedule(payload, {hardwareConcurrency = globalThis.navigator?.hardwareConcurrency,
  deviceMemory = globalThis.navigator?.deviceMemory, workersAvailable = typeof Worker !== 'undefined',
  observedStartupMs = 100, observedMergeMs = 10, parallelism, shardCount} = {}) {
  for (const [name, value] of [['parallelism', parallelism], ['shardCount', shardCount]]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > EMERGENCY_WORKER_CAP)) {
      throw new RangeError(`${name} must be an integer between 1 and ${EMERGENCY_WORKER_CAP}`);
    }
  }
  const hardware = Number.isFinite(hardwareConcurrency) ? clamp(Math.floor(hardwareConcurrency), 1, EMERGENCY_WORKER_CAP) : 2;
  const profile = payload.searchProfile || 'balanced';
  const work = inventoryWorkEstimate(payload);
  const reserve = Math.max(1, Math.ceil(hardware * (profile === 'fast' ? 0.5 : profile === 'deep' ? 0.125 : 0.25)));
  const cpuLimit = Math.max(1, hardware - reserve);
  // Measurements: cold workers cost ~100 ms and 25–60 MiB on this vault.
  // Use conservative retained-memory admission, not deviceMemory as free RAM.
  const perWorkerMiB = 32 + work.items * 0.025;
  const memoryMiB = Number.isFinite(deviceMemory) && deviceMemory > 0 ? deviceMemory * 1024 / 8 : 512;
  const memoryLimit = Math.max(1, Math.floor(memoryMiB / perWorkerMiB));
  const overhead = Math.max(1, observedStartupMs + observedMergeMs);
  // Small quotient domains rarely amortize cold workers, even in large vaults.
  // This is a scheduling cost estimate, deliberately not a feasibility oracle.
  const exact = ['health', 'melee', 'grenade', 'super', 'class', 'weapons'].every(s => payload.userConstraints?.exact?.[s]);
  // Deep/fuzzy ranking visits physical alternatives. Measured fixed-assignment
  // throughput is ~0.24 ms/evaluation; exact-first quotient bounds are much
  // cheaper and must not inherit that exhaustive-work estimate.
  const workMs = profile === 'deep' || !exact ? work.physicalCombinations * 0.24 : work.mathCombinations * 0.002;
  const amortization = profile === 'fast' ? 8 : profile === 'deep' ? 1 : 3;
  const taskLimit = Math.max(1, Math.floor(Math.sqrt(workMs / (overhead * amortization))));
  // Until budgets are batch-global, extra shards multiply profile effort.
  // Ordinary Fast/Balanced must stay single-shard regardless of core count.
  const profileLimit = profile === 'deep' ? 4 : 1;
  const requestedWorkers = parallelism ?? Math.max(1, Math.min(profileLimit, cpuLimit, memoryLimit, taskLimit, work.shardableDomain));
  // Explicit counts override the cost model for calibration, not the amount
  // of available work. Keep shard coordinates even when the pool is smaller.
  const shards = shardCount ?? requestedWorkers;
  return {hardwareConcurrency: hardware, requestedWorkers, workerCount: workersAvailable
    ? Math.min(requestedWorkers, shards, Math.max(1, work.shardableDomain)) : 0,
    shardCount: workersAvailable ? shards : 1, cpuLimit, memoryLimit, taskLimit, perWorkerMiB,
    estimatedWorkMs: workMs, observedStartupMs, observedMergeMs, profile, work};
}
