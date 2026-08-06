import { STATS } from "./armor-model.mjs";

export function getArmorRequirement(target, fragment) {
  return target === 0 ? 0 : Math.max(0, target - fragment);
}

export function createBalancedTargetPlan({
  targets,
  fragments,
  lockedStats = [],
  budget,
}) {
  const armorNeeded = STATS.reduce(
    (sum, stat) => (
      sum + getArmorRequirement(targets[stat], fragments[stat] || 0)
    ),
    0,
  );
  const requiredChange = Math.abs(armorNeeded - budget);
  if (requiredChange === 0) return { ...targets };

  const trim = armorNeeded > budget;
  const locked = new Set(lockedStats);
  const editable = STATS.filter(
    stat => !locked.has(stat) && targets[stat] > 0,
  );
  if (editable.length === 0) return null;

  let states = new Map([[
    0,
    { values: {}, squareCost: 0, maxChange: 0 },
  ]]);
  for (const stat of editable) {
    const current = targets[stat];
    const currentRequirement = getArmorRequirement(
      current,
      fragments[stat] || 0,
    );
    const candidates = [{ target: current, change: 0, progress: 0 }];
    const first = trim
      ? Math.floor((current - 1) / 5) * 5
      : Math.ceil((current + 1) / 5) * 5;
    const limit = trim ? 0 : 200;

    for (
      let value = first;
      trim ? value >= limit : value <= limit;
      value += trim ? -5 : 5
    ) {
      const nextRequirement = getArmorRequirement(
        value,
        fragments[stat] || 0,
      );
      const progress = trim
        ? currentRequirement - nextRequirement
        : nextRequirement - currentRequirement;
      if (progress <= 0 || progress > requiredChange) continue;
      candidates.push({
        target: value,
        change: Math.abs(value - current),
        progress,
      });
    }

    const nextStates = new Map();
    for (const [achieved, state] of states) {
      for (const candidate of candidates) {
        const nextAchieved = achieved + candidate.progress;
        if (nextAchieved > requiredChange) continue;
        const nextState = {
          values: { ...state.values, [stat]: candidate.target },
          squareCost: state.squareCost + candidate.change * candidate.change,
          maxChange: Math.max(state.maxChange, candidate.change),
        };
        const previous = nextStates.get(nextAchieved);
        if (
          !previous ||
          nextState.squareCost < previous.squareCost ||
          (
            nextState.squareCost === previous.squareCost &&
            nextState.maxChange < previous.maxChange
          )
        ) {
          nextStates.set(nextAchieved, nextState);
        }
      }
    }
    states = nextStates;
  }

  const exact = states.get(requiredChange);
  return exact ? { ...targets, ...exact.values } : null;
}
