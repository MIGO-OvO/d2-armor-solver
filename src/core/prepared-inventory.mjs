// A verification Worker retains only one batch's vault. The reference remains
// stable across message clones, so the engine's WeakMap can reuse its spec.
// Worker termination releases it; a new batch replaces it. No global registry.
export function createPreparedInventoryMerge(merge) {
  let prepared = null;
  return payload => {
    if (payload.request !== undefined) {
      prepared = {id: payload.requestId, request: payload.request};
    } else if (!prepared || !Number.isSafeInteger(payload.requestId) || prepared.id !== payload.requestId) {
      throw Object.assign(new Error('Inventory verification request must be prepared again'),
        {name: 'MissingPreparedInventoryError'});
    }
    return merge({...payload, request: prepared.request});
  };
}
