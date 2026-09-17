// Bump whenever legal tuning transitions change. Proof/cache identities must
// never reuse a negative result obtained from a smaller assignment domain.
export const TUNING_DOMAIN_ID = 'optional-tuning-v1';

export function getTuningCost(assignments = []) {
  let directionalCount = 0;
  let installedCount = 0;
  for (const assignment of assignments) {
    if (assignment?.mode === '+5-5' || assignment?.mode === 'shift') directionalCount++;
    if (['+5-5', 'shift', '+3', 'plus3'].includes(assignment?.mode)) installedCount++;
  }
  return {directionalCount, installedCount};
}

export function compareTuningCosts(left, right) {
  return left.installedCount - right.installedCount || left.directionalCount - right.directionalCount;
}
