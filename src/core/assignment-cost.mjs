const tuningKey = tuning => !tuning || tuning.mode === 'none' ? 'none'
  : tuning.mode === '+3' || tuning.mode === 'plus3' ? '+3' : `${tuning.from}>${tuning.to}`;
const modKey = mod => mod?.size ? `${mod.size}:${mod.stat}` : 'none';

export function getAssignmentCost(pieces, evaluation) {
  let changedSocketCount = 0;
  let installedTuningCount = 0;
  let directionalTuningCount = 0;
  let armorModCount = 0;
  let armorModPoints = 0;
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index];
    const current = piece.tuningInstalled === false ? {mode: 'none'}
      : piece.tuningMode === 'plus3' ? {mode: '+3'}
      : {mode: '+5-5', from: piece.tuningFrom, to: piece.tuningTo};
    const tuning = evaluation.tuningAssignments?.[index];
    const mod = evaluation.modAssignments?.[index];
    installedTuningCount += Number(Boolean(tuning) && tuning.mode !== 'none');
    directionalTuningCount += Number(tuning?.mode === '+5-5' || tuning?.mode === 'shift');
    changedSocketCount += Number(tuningKey(current) !== tuningKey(tuning));
    changedSocketCount += Number(modKey({size: piece.armorModSize, stat: piece.armorModStat}) !== modKey(mod));
    armorModCount += Number(Boolean(mod?.size));
    armorModPoints += mod?.size || 0;
  }
  return {installedTuningCount, directionalTuningCount, changedSocketCount, armorModCount, armorModPoints};
}

export function compareAssignmentCosts(left, right) {
  if (!left || !right) return 0;
  return left.installedTuningCount - right.installedTuningCount
    || left.changedSocketCount - right.changedSocketCount
    || (left.armorModPoints || 0) - (right.armorModPoints || 0)
    || (left.armorModCount || 0) - (right.armorModCount || 0);
}
