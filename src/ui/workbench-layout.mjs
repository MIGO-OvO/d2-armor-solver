// Move existing nodes, not duplicate controls or CSS-only visual ordering:
// keyboard order and both the web/desktop input trees stay in agreement.
export function arrangeWorkbenchInputs(doc, isUpgrade) {
  const workspace = doc.querySelector('.workspace-grid');
  const targets = doc.getElementById('inputCard');
  const inventory = doc.getElementById('inventoryImportCard');
  const current = doc.getElementById('upgradeBuildCard');
  if (!workspace || !targets || !inventory || !current) return;
  workspace.prepend(targets);
  if (workspace.parentElement !== inventory.parentElement) return;
  if (isUpgrade) current.after(workspace);
  else inventory.before(workspace);
}
