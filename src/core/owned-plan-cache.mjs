// Derived matching is asynchronous, independent of inventory search progress.
// Only immutable candidate/rule/input keys invalidate it. One request runs at a
// time; newer candidate sets share in-flight work instead of starving it.

// An owned plan is *settled* when its owned/farm conclusion is proven for the
// source solution — including a fully-owned certified skeleton or a completed
// macro-equivalence proof whose residual alternative search was truncated.
// Only a truncated ownership search (`matchingProof.complete === false`) is
// provisional: it is worth showing immediately, but must never block a later
// single-solution retry with a fresh, dedicated budget.
export function isOwnedPlanSettled(plan) {
  if (!plan) return true;
  return plan.matchingProof?.complete !== false;
}

export function createOwnedPlanCache({calculate, onUpdate = () => {}, limit = 64}) {
  const cache = new Map();
  let revision = 0;
  let active = null;
  const aborted = () => Object.assign(new Error('Owned plan inputs changed'), {name: 'AbortError'});
  const read = (solutions, keys) => keys.map((key, index) => {
    const plan = cache.get(key);
    return plan ? {...plan, solution: solutions[index]} : null;
  }).filter(Boolean);
  // A provisional entry is treated as missing by `revalidate` requests, so a
  // truncated search can be retried once the user asks for that solution.
  const missingFor = (keys, {revalidate = false} = {}) => keys
    .map((key, index) => ({key, index}))
    .filter(row => !cache.has(row.key)
      || (revalidate && !isOwnedPlanSettled(cache.get(row.key))));

  async function ensureSnapshot(request, keys, expectedRevision = revision, options = {}) {
    if (expectedRevision !== revision) throw aborted();
    const missing = missingFor(keys, options);
    if (!missing.length) return read(request.solutions, keys);
    if (active) {
      await active.promise;
      return ensureSnapshot(request, keys, expectedRevision, options);
    }
    const controller = new AbortController();
    const job = {controller, promise: null};
    const sources = missing.map(row => request.solutions[row.index]);
    active = job;
    job.promise = Promise.resolve().then(() => calculate({...request, solutions: sources,
      maxResults: sources.length}, {signal: controller.signal})).then(plans => {
      if (expectedRevision !== revision || controller.signal.aborted) throw aborted();
      const byIndex = new Map(plans.map(plan => [plan.sourceIndex, plan]));
      missing.forEach(({key}, index) => {
        if (cache.size >= Math.max(limit, keys.length) && !cache.has(key)) cache.delete(cache.keys().next().value);
        cache.set(key, byIndex.get(index) || null);
      });
      onUpdate();
    }).finally(() => { if (active === job) active = null; });
    await job.promise;
    if (expectedRevision !== revision) throw aborted();
    return read(request.solutions, keys);
  }
  return {
    ensure: (request, keys) => ensureSnapshot({...request, solutions: [...request.solutions]}, [...keys]),
    // Recalculate entries whose owned/farm conclusion is still provisional.
    revalidate: (request, keys) => ensureSnapshot(
      {...request, solutions: [...request.solutions]}, [...keys], revision, {revalidate: true}),
    peek(key, solution) {
      const plan = cache.get(key);
      return plan && solution ? {...plan, solution} : plan || null;
    },
    has: key => cache.has(key),
    isSettled: key => cache.has(key) && isOwnedPlanSettled(cache.get(key)),
    invalidate() {
      revision++;
      cache.clear();
      active?.controller.abort();
      active = null;
    },
  };
}
